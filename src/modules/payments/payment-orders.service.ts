import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DB,
  LocaleCode,
  PaymentEventResult,
  PaymentOrderStatus,
} from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { WalletService } from '@modules/wallet/wallet.service';

import type {
  CallbackRequest,
  CheckoutInstruction,
  CommandOutcome,
  OrderSnapshot,
  ParsedCallback,
  PaymentProviderId,
  ProviderCommand,
  ProviderResponse,
  RejectedCallback,
  VerifiedCallback,
} from './providers/payment-provider';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';

/** A Payment Order as the employer's own client sees it (§6.7). */
export interface PaymentOrderView {
  id: string;
  provider: PaymentProviderId;
  coins: number;
  coinPriceUzs: number;
  amountUzs: number;
  status: PaymentOrderStatus;
  providerTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
  paidAt: Date | null;
  updatedAt: Date;
}

/** The order row this service reads. Narrower than the table on purpose. */
interface OrderRow {
  id: string;
  employer_user_id: string;
  provider: PaymentProviderId;
  coins: number;
  coin_price_uzs: string;
  amount_uzs: string;
  status: PaymentOrderStatus;
  provider_transaction_id: string | null;
  failure_code: string | null;
  created_at: Date;
  paid_at: Date | null;
  updated_at: Date;
}

/** One row of the reconciliation trail, as this service writes them. */
interface EventRow {
  orderId: string | null;
  provider: PaymentProviderId;
  method: string;
  result: PaymentEventResult;
  detail: string;
  providerTransactionId: string | null;
  statusBefore?: PaymentOrderStatus | null;
  statusAfter?: PaymentOrderStatus | null;
  amountUzs?: number | null;
  payload: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payment Orders, and the only place in the product where a provider's word becomes Coins
 * (§6.7, §12.6, BR-19, BR-20).
 *
 * §6.7's governing sentence is *"A client-side success redirect is not sufficient to credit
 * Coins"*, so nothing an employer's own client can send reaches the credit path. Coins move
 * in exactly one method here - `perform` - reached only from a callback whose signature the
 * provider's adapter has already verified.
 *
 * **BR-19 - exactly once, whatever the provider retries - is four things, and no `if` among
 * them.**
 *
 * 1. `SELECT ... FOR UPDATE` on the order, so two simultaneous callbacks queue instead of
 *    interleaving. The second one reads the state the first one committed.
 * 2. A conditional `UPDATE ... WHERE status = 'pending'`: the loser of a race updates no
 *    rows, and its own transaction takes the already-paid branch.
 * 3. `wallet_transactions_one_credit_per_reference_idx`, so even a credit that somehow
 *    escaped both of the above cannot write a second `top_up` row for one order.
 * 4. `payment_orders_provider_transaction_idx`, so one provider transaction can never be
 *    replayed against a different order.
 *
 * Each catches something the others cannot, which is why all four exist. UAT-22 delivers the
 * same successful callback twice.
 *
 * **The state change and its event are one transaction.** Same rule as BR-08's audit rows:
 * a transition nobody recorded is a transition nobody can reconcile, and §6.7 requires the
 * status history for exactly that. The `payment_events_rejected_changes_nothing` check makes
 * the reverse unrepresentable - a refused callback cannot carry a transition.
 *
 * **Nothing throws from inside a transaction.** Every handler returns a `CommandOutcome`
 * that the adapter renders, because a throw would roll back the event row that explains why
 * the callback was refused - the exact trap MEMORY.md records from M1's OTP counter, in the
 * one place where losing it would also lose the audit trail for money.
 */
@Injectable()
export class PaymentOrdersService {
  private readonly logger = new Logger(PaymentOrdersService.name);

  private readonly minCoins: number;
  private readonly maxCoins: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly providers: PaymentProviderRegistry,
    private readonly wallet: WalletService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.minCoins = config.get('PAYMENT_MIN_COINS', { infer: true });
    this.maxCoins = config.get('PAYMENT_MAX_COINS', { infer: true });
  }

  /** Which providers this deployment can actually take money through (§6.7). */
  availableProviders(): PaymentProviderId[] {
    return this.providers.available();
  }

  /** The order bounds, so the client can constrain its own picker before asking. */
  bounds(): { minCoins: number; maxCoins: number } {
    return { minCoins: this.minCoins, maxCoins: this.maxCoins };
  }

  /**
   * Opens a Payment Order and returns the checkout to open (§6.7, §12.3.1).
   *
   * **The amount is computed here and nowhere else.** §12.3.1: "client-provided totals are
   * never trusted as the source of truth", so the request carries a Coin count and the price
   * comes from server configuration. The price is then *written onto the order*, because
   * §10.5 allows repricing and an employer must owe what they were quoted rather than what
   * the price became while their checkout was open.
   *
   * Reading the wallet first is deliberate: it creates the wallet row this order's foreign
   * key needs, grants BR-15's bonus if it is still owed, and returns the current price -
   * three things that would otherwise be three calls, and one of which (the row) would
   * otherwise be a foreign-key error on an employer who has never opened the Wallet screen.
   */
  async create(
    employerUserId: string,
    provider: PaymentProviderId,
    coins: number,
    locale: LocaleCode,
  ): Promise<{ order: PaymentOrderView; checkout: CheckoutInstruction }> {
    if (
      !Number.isInteger(coins) ||
      coins < this.minCoins ||
      coins > this.maxCoins
    ) {
      throw new BadRequestError('payments.coins_out_of_range', {
        min: this.minCoins,
        max: this.maxCoins,
      });
    }

    if (!this.providers.isAvailable(provider)) {
      // §6.7 lets the client present the provider choice, so it reads the available list
      // from `GET /wallet`. Reaching this means the list was stale or ignored.
      throw new ConflictError('payments.provider_unavailable');
    }

    const { pricing } = await this.wallet.read(employerUserId);
    const amountUzs = coins * pricing.coinPriceUzs;

    const row = await this.db
      .insertInto('payment_orders')
      .values({
        employer_user_id: employerUserId,
        provider,
        coins,
        coin_price_uzs: String(pricing.coinPriceUzs),
        amount_uzs: String(amountUzs),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const checkout = this.providers
      .get(provider)
      .checkout({ id: row.id, coins, amountUzs, locale });

    this.logger.log(
      `Employer ${employerUserId} opened ${provider} order ${row.id} ` +
        `for ${coins} coins (UZS ${amountUzs})`,
    );

    return { order: toView(row), checkout };
  }

  /** The employer's own orders, newest first - §6.7's status and retry in Wallet. */
  async list(
    employerUserId: string,
    limit: number,
    offset: number,
  ): Promise<PaymentOrderView[]> {
    const rows = await this.db
      .selectFrom('payment_orders')
      .selectAll()
      .where('employer_user_id', '=', employerUserId)
      // `id` as the tiebreaker, for the reason the ledger has one: two orders can share a
      // timestamp, and a page boundary between them would repeat or skip one.
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => toView(row as OrderRow));
  }

  /** One order, scoped to its owner: an order id is not an authorization. */
  async read(
    employerUserId: string,
    orderId: string,
  ): Promise<PaymentOrderView> {
    const row = await this.db
      .selectFrom('payment_orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('payments.order_not_found');
    }

    return toView(row);
  }

  /**
   * The one entry point for provider callbacks (§12.6).
   *
   * Parse and verify, then act, then render - in that order, and the types enforce it: a
   * `ParsedCallback` that is not verified carries no command to act on.
   */
  async handleCallback(
    provider: PaymentProviderId,
    request: CallbackRequest,
  ): Promise<ProviderResponse> {
    const adapter = this.providers.get(provider);
    const callback = adapter.parse(request);

    if (!callback.verified) {
      await this.recordRejection(provider, callback);

      return adapter.renderRejection(callback);
    }

    const outcome = await this.execute(provider, callback);

    return adapter.render(callback, outcome);
  }

  /**
   * A callback that failed verification, recorded and nothing else (§12.6).
   *
   * This is the trail's most important row and the easiest one to leave out: a signature
   * failure has no order to attach to, so `order_id` is null, and it is written outside any
   * state-changing transaction because there is no state change to be part of.
   */
  private async recordRejection(
    provider: PaymentProviderId,
    callback: RejectedCallback,
  ): Promise<void> {
    this.logger.warn(
      `Refused a ${provider} callback (${callback.method}): ${callback.detail}`,
    );

    await this.db.transaction().execute((trx) =>
      this.event(trx, {
        orderId: null,
        provider,
        method: callback.method,
        result: 'rejected',
        detail: callback.detail,
        providerTransactionId: null,
        payload: {},
      }),
    );
  }

  private execute(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
  ): Promise<CommandOutcome> {
    switch (callback.command.kind) {
      case 'check':
        return this.check(provider, callback, callback.command);
      case 'create':
        return this.createTransaction(provider, callback, callback.command);
      case 'perform':
        return this.perform(provider, callback, callback.command);
      case 'cancel':
        return this.cancel(provider, callback, callback.command);
      case 'status':
        return this.status(provider, callback, callback.command);
      case 'statement':
        return this.statement(provider, callback, callback.command);
    }
  }

  /**
   * "May this order be paid at this amount?" - Payme's `CheckPerformTransaction`.
   *
   * Changes nothing, and answers the two questions §12.6 asks it to validate: the account
   * and the amount.
   */
  private check(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'check' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const order = await this.lockById(trx, provider, command.orderId);
      const refusal = payableRefusal(order, command.amountUzs);

      if (refusal || !order) {
        await this.event(trx, {
          orderId: order?.id ?? null,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: refusal ?? 'order_not_found',
          providerTransactionId: null,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: refusal ?? 'order_not_found' };
      }

      await this.event(trx, {
        orderId: order.id,
        provider,
        method: callback.method,
        result: 'verified',
        detail: 'payable',
        providerTransactionId: null,
        amountUzs: command.amountUzs,
        payload: { ...command },
      });

      return { ok: true, kind: 'check', order: snapshot(order) };
    });
  }

  /**
   * The provider has opened a transaction against the order: Payme's `CreateTransaction`,
   * CLICK's `Prepare`.
   *
   * `created -> pending`, and it stores the provider's transaction id, which is what every
   * later callback is matched on. Retrying it with the **same** transaction id is idempotent
   * - both providers do retry, and §12.6 asks for repeated Create requests to be tested.
   * Retrying with a *different* one is refused: two live transactions against one order is
   * how an order gets paid twice.
   */
  private createTransaction(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'create' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const order = await this.lockById(trx, provider, command.orderId);

      // Already ours, already open: answer with the same thing as the first time.
      if (
        order &&
        order.status === 'pending' &&
        order.provider_transaction_id === command.providerTransactionId
      ) {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'verified',
          detail: 'already_open',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: true, kind: 'created', order: snapshot(order) };
      }

      const refusal =
        payableRefusal(order, command.amountUzs) ??
        (order?.status === 'pending' ? 'order_not_payable' : null);

      if (refusal || !order) {
        await this.event(trx, {
          orderId: order?.id ?? null,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: refusal ?? 'order_not_found',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: refusal ?? 'order_not_found' };
      }

      // **Is this transaction id already attached to a different order?**
      //
      // `payment_orders_provider_transaction_idx` would refuse the update below, but as a
      // raw database error thrown out of the transaction - which would roll back the very
      // event row that recorded why, and answer the provider with a 500 instead of a code it
      // understands. That is the trap MEMORY.md records from M1's OTP counter, and this is
      // where it would cost an unexplained failed payment. So the collision is *read* first
      // and the index stays a backstop.
      const claimed = await trx
        .selectFrom('payment_orders')
        .select('id')
        .where('provider', '=', provider)
        .where('provider_transaction_id', '=', command.providerTransactionId)
        .executeTakeFirst();

      if (claimed && claimed.id !== order.id) {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'transaction_claimed_by_another_order',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command, claimedBy: claimed.id },
        });

        return { ok: false, code: 'order_not_payable' };
      }

      const updated = await trx
        .updateTable('payment_orders')
        .set({
          status: 'pending',
          provider_transaction_id: command.providerTransactionId,
          updated_at: sql`now()`,
        })
        .where('id', '=', order.id)
        .where('status', '=', 'created')
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        // The row moved under us despite the lock, which should be impossible. Recorded
        // rather than asserted, because a provider deserves an answer either way.
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'order_not_payable',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: 'order_not_payable' };
      }

      await this.event(trx, {
        orderId: order.id,
        provider,
        method: callback.method,
        result: 'verified',
        detail: 'opened',
        providerTransactionId: command.providerTransactionId,
        statusBefore: order.status,
        statusAfter: 'pending',
        amountUzs: command.amountUzs,
        payload: { ...command },
      });

      return {
        ok: true,
        kind: 'created',
        order: snapshot(updated),
      };
    });
  }

  /**
   * The money arrived: Payme's `PerformTransaction`, CLICK's `Complete`.
   *
   * **The only method in the product that credits Coins**, and the reason the four BR-19
   * guarantees listed on this class exist. The order is found by the provider's transaction
   * id - Payme does not re-send the account - locked, moved `pending -> paid` by a
   * conditional update, and credited in the same transaction.
   *
   * An order already `paid` returns success **without crediting again**. That is not a
   * special case bolted on for UAT-22: from the provider's point of view the transaction did
   * perform, and telling it otherwise would make it retry forever.
   */
  private perform(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'perform' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const order = await this.lockByTransaction(
        trx,
        provider,
        command.providerTransactionId,
      );

      if (!order) {
        await this.event(trx, {
          orderId: null,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'transaction_not_found',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: 'transaction_not_found' };
      }

      // CLICK re-sends both the order and the amount on completion, so both are re-checked.
      // Payme sends neither, having had them checked twice already on the way in.
      const mismatch =
        (command.orderId !== null && command.orderId !== order.id) ||
        (command.amountUzs !== null &&
          Number(order.amount_uzs) !== command.amountUzs);

      if (mismatch) {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'invalid_amount',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: 'invalid_amount' };
      }

      if (order.status === 'paid') {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'verified',
          // The duplicate-callback case, named so it is visible in the trail rather than
          // looking like a second payment.
          detail: 'already_paid',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: true, kind: 'performed', order: snapshot(order) };
      }

      if (order.status !== 'pending') {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'order_not_payable',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: false, code: 'order_not_payable' };
      }

      const paid = await trx
        .updateTable('payment_orders')
        .set({ status: 'paid', paid_at: sql`now()`, updated_at: sql`now()` })
        .where('id', '=', order.id)
        // BR-19's conditional update. With the row lock held this is belt and braces, and
        // it is the belt: if the lock is ever lost to a refactor, the second callback still
        // updates nothing.
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();

      if (!paid) {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'verified',
          detail: 'already_paid',
          providerTransactionId: command.providerTransactionId,
          amountUzs: command.amountUzs,
          payload: { ...command },
        });

        return { ok: true, kind: 'performed', order: snapshot(order) };
      }

      const credited = await this.wallet.creditTopUp(
        trx,
        order.employer_user_id,
        {
          id: order.id,
          coins: order.coins,
          coinPriceUzs: Number(order.coin_price_uzs),
        },
      );

      await this.event(trx, {
        orderId: order.id,
        provider,
        method: callback.method,
        result: 'verified',
        // `credited: false` here would mean the ledger index refused a second row for an
        // order this transaction had just moved out of `pending` - which cannot happen, and
        // is recorded rather than asserted so that if it ever does, the trail says so.
        detail: credited ? 'paid_and_credited' : 'paid_already_credited',
        providerTransactionId: command.providerTransactionId,
        statusBefore: order.status,
        statusAfter: 'paid',
        amountUzs: command.amountUzs ?? Number(order.amount_uzs),
        payload: { ...command, coins: order.coins },
      });

      return { ok: true, kind: 'performed', order: snapshot(paid) };
    });
  }

  /**
   * Cancelled or refunded by the provider (BR-20, UAT-23).
   *
   * Two shapes, and which one applies is decided by the order's own state rather than by the
   * provider's vocabulary: an order that never reached `paid` becomes `cancelled` and no Coin
   * ever existed, and one that did becomes `reversed`, with the ledger taking back what it
   * can (see `WalletService.reverseTopUp`). Repeating the call is idempotent.
   */
  private cancel(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'cancel' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const order =
        (await this.lockByTransaction(
          trx,
          provider,
          command.providerTransactionId,
        )) ??
        // CLICK cancels a `Prepare` that failed, whose transaction id was never stored.
        (command.orderId === null
          ? undefined
          : await this.lockById(trx, provider, command.orderId));

      if (!order) {
        await this.event(trx, {
          orderId: null,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'transaction_not_found',
          providerTransactionId: command.providerTransactionId,
          payload: { ...command },
        });

        return { ok: false, code: 'transaction_not_found' };
      }

      if (order.status === 'cancelled' || order.status === 'reversed') {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'verified',
          detail: 'already_cancelled',
          providerTransactionId: command.providerTransactionId,
          payload: { ...command },
        });

        return { ok: true, kind: 'cancelled', order: snapshot(order) };
      }

      const target: PaymentOrderStatus =
        order.status === 'paid' ? 'reversed' : 'cancelled';

      const cancelled = await trx
        .updateTable('payment_orders')
        .set({
          status: target,
          failure_code: command.reason ?? 'provider_cancelled',
          updated_at: sql`now()`,
        })
        .where('id', '=', order.id)
        .where('status', '=', order.status)
        .returningAll()
        .executeTakeFirst();

      if (!cancelled) {
        await this.event(trx, {
          orderId: order.id,
          provider,
          method: callback.method,
          result: 'rejected',
          detail: 'order_not_payable',
          providerTransactionId: command.providerTransactionId,
          payload: { ...command },
        });

        return { ok: false, code: 'order_not_payable' };
      }

      const recovery =
        target === 'reversed'
          ? await this.wallet.reverseTopUp(trx, order.employer_user_id, {
              id: order.id,
              coins: order.coins,
              coinPriceUzs: Number(order.coin_price_uzs),
            })
          : null;

      await this.event(trx, {
        orderId: order.id,
        provider,
        method: callback.method,
        result: 'verified',
        detail:
          recovery === null
            ? 'cancelled'
            : `reversed_recovered_${recovery.recoveredCoins}_of_${order.coins}`,
        providerTransactionId: command.providerTransactionId,
        statusBefore: order.status,
        statusAfter: target,
        payload: { ...command, ...(recovery ?? {}) },
      });

      return {
        ok: true,
        kind: 'cancelled',
        order: snapshot(cancelled),
      };
    });
  }

  /** Payme's `CheckTransaction`: a status poll, which changes nothing. */
  private status(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'status' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const order = await this.findByTransaction(
        trx,
        provider,
        command.providerTransactionId,
      );

      await this.event(trx, {
        orderId: order?.id ?? null,
        provider,
        method: callback.method,
        result: order ? 'verified' : 'rejected',
        detail: order ? `status_${order.status}` : 'transaction_not_found',
        providerTransactionId: command.providerTransactionId,
        payload: { ...command },
      });

      return order
        ? { ok: true, kind: 'status', order: snapshot(order) }
        : { ok: false, code: 'transaction_not_found' };
    });
  }

  /**
   * Payme's `GetStatement`: every transaction in a window, for the provider's own
   * reconciliation (§12.6).
   *
   * Only orders that reached a provider transaction are included - an order nobody ever
   * opened a checkout for is not something the provider has a record of, and returning it
   * would make the two statements disagree by design.
   */
  private statement(
    provider: PaymentProviderId,
    callback: VerifiedCallback,
    command: Extract<ProviderCommand, { kind: 'statement' }>,
  ): Promise<CommandOutcome> {
    return this.db.transaction().execute<CommandOutcome>(async (trx) => {
      const rows = await trx
        .selectFrom('payment_orders')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_transaction_id', 'is not', null)
        .where('created_at', '>=', new Date(command.fromMs))
        .where('created_at', '<=', new Date(command.toMs))
        .orderBy('created_at', 'asc')
        .execute();

      await this.event(trx, {
        orderId: null,
        provider,
        method: callback.method,
        result: 'verified',
        detail: `statement_${rows.length}_orders`,
        providerTransactionId: null,
        payload: { ...command, orders: rows.length },
      });

      return {
        ok: true,
        kind: 'statement',
        orders: rows.map((row) => snapshot(row as OrderRow)),
      };
    });
  }

  /**
   * The order by its internal id, locked.
   *
   * The provider is part of the predicate: a Payme callback naming an order that was opened
   * for CLICK is not that order, and matching on the id alone would let one provider act on
   * another's transaction.
   *
   * The UUID shape is checked first because a provider can send anything at all in its
   * account field, and `WHERE id = 'garbage'` is a Postgres type error rather than an empty
   * result - which would abort the transaction and lose the event row that recorded it.
   */
  private async lockById(
    trx: Transaction<DB>,
    provider: PaymentProviderId,
    orderId: string,
  ): Promise<OrderRow | undefined> {
    if (!UUID.test(orderId)) {
      return undefined;
    }

    const row = await trx
      .selectFrom('payment_orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('provider', '=', provider)
      .forUpdate()
      .executeTakeFirst();

    return row;
  }

  /** The order by the provider's transaction id, locked. BR-19's serialization point. */
  private async lockByTransaction(
    trx: Transaction<DB>,
    provider: PaymentProviderId,
    providerTransactionId: string,
  ): Promise<OrderRow | undefined> {
    const row = await trx
      .selectFrom('payment_orders')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_transaction_id', '=', providerTransactionId)
      .forUpdate()
      .executeTakeFirst();

    return row;
  }

  /** The same lookup without the lock, for the reads that change nothing. */
  private async findByTransaction(
    trx: Transaction<DB>,
    provider: PaymentProviderId,
    providerTransactionId: string,
  ): Promise<OrderRow | undefined> {
    const row = await trx
      .selectFrom('payment_orders')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_transaction_id', '=', providerTransactionId)
      .executeTakeFirst();

    return row;
  }

  /** One row of the trail. Always in the caller's transaction - see the class comment. */
  private async event(trx: Transaction<DB>, row: EventRow): Promise<void> {
    await trx
      .insertInto('payment_events')
      .values({
        order_id: row.orderId,
        provider: row.provider,
        method: row.method,
        result: row.result,
        detail: row.detail,
        provider_transaction_id: row.providerTransactionId,
        status_before: row.statusBefore ?? null,
        status_after: row.statusAfter ?? null,
        amount_uzs:
          row.amountUzs === undefined || row.amountUzs === null
            ? null
            : String(row.amountUzs),
        payload: JSON.stringify(row.payload),
      })
      .execute();
  }
}

/**
 * Why this order cannot be paid at this amount, or null if it can.
 *
 * One function for both `check` and `create` because §12.6 asks the same two questions of
 * both - "validate order/account and amount" - and two copies would eventually answer them
 * differently.
 */
function payableRefusal(
  order: OrderRow | undefined,
  amountUzs: number,
): 'order_not_found' | 'invalid_amount' | 'order_not_payable' | null {
  if (!order) {
    return 'order_not_found';
  }

  // Exact, not a tolerance. `numeric(14,2)` arrives as a string, and `Number` on it is
  // exact for every amount this product can represent.
  if (Number(order.amount_uzs) !== amountUzs) {
    return 'invalid_amount';
  }

  return order.status === 'created' || order.status === 'pending'
    ? null
    : 'order_not_payable';
}

/** The row as a provider adapter needs it: epoch milliseconds, no database types. */
function snapshot(row: OrderRow): OrderSnapshot {
  return {
    id: row.id,
    status: row.status,
    coins: row.coins,
    amountUzs: Number(row.amount_uzs),
    providerTransactionId: row.provider_transaction_id,
    createdAtMs: row.created_at.getTime(),
    paidAtMs: row.paid_at === null ? null : row.paid_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

/** The row as the employer's client sees it. */
function toView(row: OrderRow): PaymentOrderView {
  return {
    id: row.id,
    provider: row.provider,
    coins: row.coins,
    coinPriceUzs: Number(row.coin_price_uzs),
    amountUzs: Number(row.amount_uzs),
    status: row.status,
    providerTransactionId: row.provider_transaction_id,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    updatedAt: row.updated_at,
  };
}

/** Kept for the callback controller, which hands raw request parts straight through. */
export type { CallbackRequest, ParsedCallback };
