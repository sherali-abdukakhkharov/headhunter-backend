import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LedgerSign } from './dto/wallet.dto';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  ConflictError,
  NotFoundError,
  PaymentRequiredError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';

import { PricingService } from './pricing.service';
import type { DB, WalletTransactionKind } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { EmployersService } from '@modules/employers/employers.service';
import type { Transaction } from 'kysely';

/** What the client needs to render the wallet screen and price an unlock (§6.2, §6.6). */
export interface WalletView {
  balanceCoins: number;
  /** The UZS value of the balance at today's price - display only, never stored. */
  balanceValueUzs: number;
  pricing: {
    coinPriceUzs: number;
    candidateUnlockCoins: number;
    candidateUnlockUzs: number;
  };
  registrationBonusAt: Date | null;
}

export interface WalletTransactionView {
  id: string;
  kind: WalletTransactionKind;
  amountCoins: number;
  balanceAfter: number;
  amountUzs: number | null;
  referenceId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface UnlockView {
  candidateUserId: string;
  costCoins: number;
  createdAt: Date;
  /** True when this call created it, false when it already existed (BR-16). */
  charged: boolean;
}

/** The outcome shape the unlock transaction returns instead of throwing. */
type UnlockOutcome =
  | { kind: 'existing'; unlock: UnlockView }
  | { kind: 'created'; unlock: UnlockView }
  | { kind: 'insufficient'; balance: number; required: number };

/**
 * The employer Coin wallet, its ledger, and Candidate Unlock (§6.6, §12.3.1).
 *
 * **The ledger is the truth and the balance is a cache.** Every write appends a row
 * carrying `balance_before` and `balance_after`, and updates `employer_wallets` in the
 * same statement pair. An integration test asserts the cache equals the sum of the ledger
 * after every kind of transaction, because that is the only thing that keeps a
 * denormalized balance honest.
 *
 * **BR-18 - debit and entitlement are atomic** - is the reason `unlock` looks the way it
 * does. Charging without granting access, or granting without charging, are both worse
 * than failing; so the debit, the entitlement and the balance update are one transaction,
 * and the transaction *returns an outcome* rather than throwing. Throwing from inside
 * `transaction().execute()` rolls the write back, which on this path would mean reporting
 * "insufficient balance" while having taken the money - the trap MEMORY.md records from
 * M1's OTP counter, in a place where it would be a financial bug rather than a security
 * one.
 *
 * **Three things are left to the database on purpose** (§12.3.1): the pair uniqueness that
 * makes BR-16 true under a double tap, the partial index that makes BR-15's bonus
 * one-time, and the append-only triggers behind BR-24. A row lock serializes the balance
 * arithmetic; the constraints catch what a lock cannot.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly employers: EmployersService,
    // Read per call, never cached: these used to be constructor fields, which is
    // exactly what made them un-editable (§10.5). A price an administrator
    // changed and the API kept quoting for hours is worse than no screen.
    private readonly pricing_: PricingService,
  ) {}

  /** Today's prices, for the client and for anything that needs to quote a cost. */
  async pricing(): Promise<WalletView['pricing']> {
    const { coinPriceUzs, candidateUnlockCoins } =
      await this.pricing_.current();

    return {
      coinPriceUzs,
      candidateUnlockCoins,
      candidateUnlockUzs: candidateUnlockCoins * coinPriceUzs,
    };
  }

  /**
   * The wallet, created and back-granted on first read if it does not exist yet.
   *
   * Employers who registered before this milestone have no wallet and no bonus row. Their
   * first read creates both - **once**, because the partial unique index says so, not
   * because this method checks anything. An employer who has already had the bonus and
   * spent it cannot mint another by opening the screen; that is a property of the index
   * rather than of the order these calls happen in.
   *
   * The alternative was a data migration that credited every existing employer at deploy
   * time. This is the same outcome without writing money into a migration, and it cannot
   * double-credit if the migration were ever re-run.
   */
  async read(employerUserId: string): Promise<WalletView> {
    await this.db
      .transaction()
      .execute((trx) => this.grantRegistrationBonus(trx, employerUserId));

    const wallet = await this.ensureWallet(this.db, employerUserId);
    const pricing = await this.pricing();

    return {
      balanceCoins: wallet.balance_coins,
      balanceValueUzs: wallet.balance_coins * pricing.coinPriceUzs,
      pricing,
      registrationBonusAt: wallet.registration_bonus_at,
    };
  }

  async transactions(
    employerUserId: string,
    limit: number,
    offset: number,
    sign?: LedgerSign,
  ): Promise<WalletTransactionView[]> {
    let query = this.db
      .selectFrom('wallet_transactions')
      .select([
        'id',
        'kind',
        'amount_coins',
        'balance_after',
        'amount_uzs',
        'reference_id',
        'reason',
        'created_at',
      ])
      .where('employer_user_id', '=', employerUserId);

    if (sign) {
      // BR-24 makes every row's sign meaningful: a credit is money or Coins
      // arriving and a debit is them leaving, whatever the kind says. Zero is
      // not a legal amount, so the two halves are exhaustive.
      query = query.where('amount_coins', sign === 'credit' ? '>' : '<', 0);
    }

    const rows = await query
      // Newest first, and `id` as the tiebreaker: two transactions can share a timestamp,
      // and a page boundary that fell between them would repeat or skip one.
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amountCoins: row.amount_coins,
      balanceAfter: row.balance_after,
      amountUzs: row.amount_uzs === null ? null : Number(row.amount_uzs),
      referenceId: row.reference_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /** §6.6's "revisiting the same candidate uses the existing unlock" - the read half. */
  async unlockFor(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<UnlockView | null> {
    const row = await this.db
      .selectFrom('candidate_unlocks')
      .select(['candidate_user_id', 'cost_coins', 'created_at'])
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    return row
      ? {
          candidateUserId: row.candidate_user_id,
          costCoins: row.cost_coins,
          createdAt: row.created_at,
          charged: false,
        }
      : null;
  }

  /**
   * The entitlement check every protected read calls (§11.1, §12.3.1, BR-17).
   *
   * Deliberately the narrowest possible method: a boolean, by primary key. It is on the
   * hot path of the candidate view, the file routes and the chat gate, and those must not
   * each grow their own version of this query.
   */
  async hasUnlock(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('candidate_unlocks')
      .select('candidate_user_id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    return row !== undefined;
  }

  /**
   * Buys a Candidate Unlock: the debit and the entitlement, atomically (BR-16, BR-18).
   *
   * **No `Idempotency-Key` here**, unlike `applications.apply` - and that is the simpler
   * answer rather than a missing one. This operation has a *natural* key: the
   * (employer, candidate) pair is unique, so any retry finds the existing entitlement and
   * returns it with `charged: false`. A header key would add a second mechanism that
   * answers the same question less well, because a client generating one key per tap
   * produces two keys for the same intent - exactly the case the pair key catches and the
   * header key does not.
   *
   * An application needs the header because two applications to one vacancy after a
   * withdrawal are legitimately different rows. Two unlocks of one candidate never are.
   */
  async unlock(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<UnlockView> {
    // First, and before anything touches the database: a multi-role account holds both roles
    // (§2.3), and unlocking yourself is not a meaningful purchase - it would also put a
    // self-reference in the ledger. It is checked ahead of the two gates below because it is
    // the more specific answer to a request that is wrong whatever else is true of it.
    if (employerUserId === candidateUserId) {
      throw new ConflictError('wallet.cannot_unlock_self');
    }

    // **Both checks happen before any money moves, and both were missing.**
    //
    // §7 lets only a *verified* employer see candidates at all, and `@RequireRole('employer')`
    // does not check verification - so an employer could be charged two Coins for access
    // `expose()` would then refuse. Harmless while nothing read the entitlement; a way to
    // take somebody's money for nothing the moment something did. The existing refusal is
    // reused rather than given a new code, because it is the one every §7-gated route already
    // returns and the client already routes on it.
    await this.employers.assertVerified(employerUserId);

    // And `candidate_unlocks.candidate_user_id` references `users.id`, so a well-formed but
    // unknown id used to surface as a foreign-key violation - a 500 for what is really a 404.
    await this.assertCandidateExists(candidateUserId);

    const outcome = await this.performUnlock(employerUserId, candidateUserId);

    // Thrown after the transaction has committed - or rather, after it has *not* written
    // anything. Inside, this would roll back nothing and report nothing.
    if (outcome.kind === 'insufficient') {
      throw new PaymentRequiredError('wallet.insufficient_coins', {
        required: outcome.required,
        balance: outcome.balance,
      });
    }

    return outcome.unlock;
  }

  private async performUnlock(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<UnlockOutcome> {
    // The self-unlock refusal is `unlock`'s, not this method's - see the comment there.
    return this.db.transaction().execute<UnlockOutcome>(async (trx) => {
      // The row lock is what serializes the arithmetic: two unlocks of *different*
      // candidates by the same employer would otherwise both read the same balance and
      // both write `balance_after` from it, losing one debit.
      const wallet = await this.lockWallet(trx, employerUserId);

      const existing = await trx
        .selectFrom('candidate_unlocks')
        .select(['candidate_user_id', 'cost_coins', 'created_at'])
        .where('employer_user_id', '=', employerUserId)
        .where('candidate_user_id', '=', candidateUserId)
        .executeTakeFirst();

      // BR-16. Checked under the lock, so the concurrent-tap case reaches the primary key
      // only if two transactions genuinely interleaved - and then one of them fails there
      // rather than double-charging.
      if (existing) {
        return {
          kind: 'existing',
          unlock: {
            candidateUserId: existing.candidate_user_id,
            costCoins: existing.cost_coins,
            createdAt: existing.created_at,
            charged: false,
          },
        };
      }

      const { coinPriceUzs, candidateUnlockCoins: unlockCoins } =
        await this.pricing_.current();

      if (wallet.balance_coins < unlockCoins) {
        // §6.6: "the unlock action is blocked and the user is routed to wallet top-up".
        // Returned, not thrown: nothing has been written yet, and it stays that way.
        return {
          kind: 'insufficient',
          balance: wallet.balance_coins,
          required: unlockCoins,
        };
      }

      const balanceAfter = wallet.balance_coins - unlockCoins;

      const transaction = await trx
        .insertInto('wallet_transactions')
        .values({
          employer_user_id: employerUserId,
          kind: 'candidate_unlock',
          amount_coins: -unlockCoins,
          balance_before: wallet.balance_coins,
          balance_after: balanceAfter,
          coin_price_uzs: String(coinPriceUzs),
          amount_uzs: String(unlockCoins * coinPriceUzs),
          reference_id: candidateUserId,
        })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();

      const unlock = await trx
        .insertInto('candidate_unlocks')
        .values({
          employer_user_id: employerUserId,
          candidate_user_id: candidateUserId,
          cost_coins: unlockCoins,
          transaction_id: transaction.id,
        })
        .returning(['candidate_user_id', 'cost_coins', 'created_at'])
        .executeTakeFirstOrThrow();

      await this.setBalance(trx, employerUserId, balanceAfter);

      this.logger.log(
        `Employer ${employerUserId} unlocked candidate ${candidateUserId} ` +
          `for ${unlockCoins} coins (balance ${balanceAfter})`,
      );

      return {
        kind: 'created',
        unlock: {
          candidateUserId: unlock.candidate_user_id,
          costCoins: unlock.cost_coins,
          createdAt: unlock.created_at,
          charged: true,
        },
      };
    });
  }

  /**
   * BR-15's one-time bonus, granted in the caller's transaction.
   *
   * Takes the transaction because it belongs to the same commit as the employer role
   * itself: a user who is an employer without a wallet, or has a wallet with no bonus, is
   * a state somebody would have to repair by hand.
   *
   * **The partial unique index is the only rule here, and that is deliberate.** There is
   * no check for "has this employer registered before" and no early return on an existing
   * wallet, because `ON CONFLICT DO NOTHING` against
   * `wallet_transactions_one_bonus_idx` already answers every case §6.6 lists - logout,
   * reinstall, device change, role switching - plus the two that race, which a check
   * cannot answer at all.
   *
   * Relying on the index rather than on the wallet's existence also settles a case the
   * specification does not mention: **employers who registered before this milestone
   * shipped.** They have no bonus row, so their first wallet touch grants it once; an
   * employer who has already had one cannot get a second whatever path is taken. Guarding
   * on "the wallet did not exist yet" instead would have quietly denied them the bonus
   * forever, which is a decision nobody made.
   *
   * Balance arithmetic is a `+` on the current row, not an assignment of `bonusCoins`:
   * the bonus is not always the wallet's first transaction any more.
   */
  async grantRegistrationBonus(
    trx: Transaction<DB>,
    employerUserId: string,
  ): Promise<void> {
    const { coinPriceUzs, registrationBonusCoins: bonusCoins } =
      await this.pricing_.current();

    if (bonusCoins === 0) {
      return;
    }

    const wallet = await this.lockWallet(trx, employerUserId);
    const balanceAfter = wallet.balance_coins + bonusCoins;

    const granted = await trx
      .insertInto('wallet_transactions')
      .values({
        employer_user_id: employerUserId,
        kind: 'registration_bonus',
        amount_coins: bonusCoins,
        balance_before: wallet.balance_coins,
        balance_after: balanceAfter,
        coin_price_uzs: String(coinPriceUzs),
        amount_uzs: String(bonusCoins * coinPriceUzs),
      })
      // The index is the rule; this is how a retry meets it without an exception.
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!granted) {
      return;
    }

    await trx
      .updateTable('employer_wallets')
      .set({
        balance_coins: balanceAfter,
        registration_bonus_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('user_id', '=', employerUserId)
      .execute();

    this.logger.log(
      `Granted ${bonusCoins} registration coins to employer ${employerUserId}`,
    );
  }

  /**
   * BR-19's ledger half: credits a paid top-up **at most once**, in the caller's
   * transaction (§6.7, M13).
   *
   * Takes the transaction rather than opening one, exactly as `grantRegistrationBonus`
   * does, and for a stronger reason: the order reaching `paid` and the Coins arriving are
   * the same event. Two transactions would allow an order marked paid whose Coins were
   * never credited - which is the failure §6.7 is written to prevent, and the one nobody
   * would notice until an employer complained.
   *
   * **The idempotency is the index, not a check.** `wallet_transactions_one_credit_per_
   * reference_idx` - created in M12 before there was anything to write into it - allows one
   * `top_up` row per order id, so `ON CONFLICT DO NOTHING` answers a duplicate callback,
   * a provider retry, a status poll that arrives late and two callbacks racing each other.
   * `false` means "already credited", which is a success from the provider's point of view
   * and is why this returns a boolean instead of throwing.
   *
   * **The price comes from the order, never from today's configuration.** §10.5: repricing
   * "affects future transactions only". An order quoted at last month's price credits at
   * last month's price, and the ledger records what was actually charged.
   */
  async creditTopUp(
    trx: Transaction<DB>,
    employerUserId: string,
    order: { id: string; coins: number; coinPriceUzs: number },
  ): Promise<boolean> {
    const wallet = await this.lockWallet(trx, employerUserId);
    const balanceAfter = wallet.balance_coins + order.coins;

    const credited = await trx
      .insertInto('wallet_transactions')
      .values({
        employer_user_id: employerUserId,
        kind: 'top_up',
        amount_coins: order.coins,
        balance_before: wallet.balance_coins,
        balance_after: balanceAfter,
        coin_price_uzs: String(order.coinPriceUzs),
        amount_uzs: String(order.coins * order.coinPriceUzs),
        reference_id: order.id,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!credited) {
      return false;
    }

    await this.setBalance(trx, employerUserId, balanceAfter);

    this.logger.log(
      `Credited ${order.coins} coins to employer ${employerUserId} ` +
        `for payment order ${order.id} (balance ${balanceAfter})`,
    );

    return true;
  }

  /**
   * Takes back a top-up that the provider reversed or refunded (§6.7's REVERSED state).
   *
   * BR-24 forbids rewriting the credit, so this is a **new** row in the opposite direction,
   * which is what "reversals are separate audited transaction entries" means.
   *
   * **It recovers what is there, not necessarily what was credited, and that is a decision
   * rather than an oversight.** The employer may have spent the Coins on an unlock before
   * the reversal arrived; those unlocks are entitlements somebody already used, and BR-16
   * makes them permanent. A full debit would drive the balance negative, which the
   * `employer_wallets_balance_non_negative` check refuses - so the transaction would abort
   * and the order would be stuck at `paid` while the provider believed it was refunded.
   * Recovering `min(balance, coins)` keeps the ledger arithmetic true and the order's state
   * honest, and the shortfall is written into the row's reason so support can see it.
   * **docs/PAYMENTS.md records this as a question for the client**, because who absorbs an
   * unrecovered refund is a commercial decision and not an engineering one.
   *
   * Idempotency here is the order's own state machine: this is only ever called inside the
   * conditional `UPDATE ... WHERE status = 'paid'` that performs the transition, so a
   * second reversal of the same order never reaches it.
   */
  async reverseTopUp(
    trx: Transaction<DB>,
    employerUserId: string,
    order: { id: string; coins: number; coinPriceUzs: number },
  ): Promise<{ recoveredCoins: number; shortfallCoins: number }> {
    const wallet = await this.lockWallet(trx, employerUserId);
    const recovered = Math.min(wallet.balance_coins, order.coins);
    const shortfall = order.coins - recovered;

    if (recovered === 0) {
      // `wallet_transactions_direction` refuses a reversal of zero, and it is right to: a
      // ledger row that moves nothing records nothing. The order still becomes `reversed`,
      // which is where this shows up.
      this.logger.warn(
        `Reversed payment order ${order.id} for employer ${employerUserId} ` +
          `with nothing to recover: all ${order.coins} coins were already spent`,
      );

      return { recoveredCoins: 0, shortfallCoins: shortfall };
    }

    const balanceAfter = wallet.balance_coins - recovered;

    await trx
      .insertInto('wallet_transactions')
      .values({
        employer_user_id: employerUserId,
        kind: 'reversal',
        amount_coins: -recovered,
        balance_before: wallet.balance_coins,
        balance_after: balanceAfter,
        coin_price_uzs: String(order.coinPriceUzs),
        amount_uzs: String(recovered * order.coinPriceUzs),
        reference_id: order.id,
        reason:
          shortfall === 0
            ? `Payment order ${order.id} reversed by the provider`
            : `Payment order ${order.id} reversed by the provider; ` +
              `${shortfall} of ${order.coins} coins were already spent`,
      })
      .execute();

    await this.setBalance(trx, employerUserId, balanceAfter);

    this.logger.log(
      `Reversed ${recovered} coins from employer ${employerUserId} ` +
        `for payment order ${order.id} (balance ${balanceAfter}, shortfall ${shortfall})`,
    );

    return { recoveredCoins: recovered, shortfallCoins: shortfall };
  }

  /**
   * §10.5's manual adjustment: a mandatory reason, a ledger row, and an audit row.
   *
   * The audit row is the caller's job (`AdminWalletsService`), because §10.4 owns that
   * table. What this guarantees is that the adjustment is a **new** ledger entry - BR-24
   * makes rewriting history impossible, so a correction is another transaction.
   */
  async adjust(
    actorUserId: string,
    employerUserId: string,
    amountCoins: number,
    reason: string,
  ): Promise<WalletTransactionView> {
    const outcome = await this.db
      .transaction()
      .execute<{ ok: true; row: WalletTransactionView } | { ok: false }>(
        async (trx) => {
          // Today's price, for the same reason every other row stores one: the
          // ledger records what an adjustment was worth when it was made, and
          // a later repricing must not change that (§10.5, BR-24).
          const { coinPriceUzs } = await this.pricing_.current();
          const wallet = await this.lockWallet(trx, employerUserId);
          const balanceAfter = wallet.balance_coins + amountCoins;

          if (balanceAfter < 0) {
            // A debit larger than the balance would violate the non-negative check and
            // abort the transaction with a database error instead of a clear message.
            return { ok: false };
          }

          const row = await trx
            .insertInto('wallet_transactions')
            .values({
              employer_user_id: employerUserId,
              kind: 'admin_adjustment',
              amount_coins: amountCoins,
              balance_before: wallet.balance_coins,
              balance_after: balanceAfter,
              coin_price_uzs: String(coinPriceUzs),
              amount_uzs: String(Math.abs(amountCoins) * coinPriceUzs),
              reason,
              actor_user_id: actorUserId,
            })
            .returning([
              'id',
              'kind',
              'amount_coins',
              'balance_after',
              'amount_uzs',
              'reference_id',
              'reason',
              'created_at',
            ])
            .executeTakeFirstOrThrow();

          await this.setBalance(trx, employerUserId, balanceAfter);

          return {
            ok: true,
            row: {
              id: row.id,
              kind: row.kind,
              amountCoins: row.amount_coins,
              balanceAfter: row.balance_after,
              amountUzs:
                row.amount_uzs === null ? null : Number(row.amount_uzs),
              referenceId: row.reference_id,
              reason: row.reason,
              createdAt: row.created_at,
            },
          };
        },
      );

    if (!outcome.ok) {
      throw new ConflictError('wallet.adjustment_would_go_negative');
    }

    this.logger.log(
      `Administrator ${actorUserId} adjusted employer ${employerUserId} ` +
        `by ${amountCoins} coins: ${reason}`,
    );

    return outcome.row;
  }

  /**
   * That there is a candidate here to unlock.
   *
   * The profile rather than the user: an unlock buys access to a candidate's contact details
   * and files, and a user with no candidate profile has neither - so `candidate_profiles` is
   * the table that answers the question the error code asks.
   */
  private async assertCandidateExists(candidateUserId: string): Promise<void> {
    const profile = await this.db
      .selectFrom('candidate_profiles')
      .select('user_id')
      .where('user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!profile) {
      throw new NotFoundError('candidate.profile_not_found');
    }
  }

  /** The wallet row, locked, creating it first if this employer has never had one. */
  private async lockWallet(
    trx: Transaction<DB>,
    employerUserId: string,
  ): Promise<{ balance_coins: number; registration_bonus_at: Date | null }> {
    await this.ensureWallet(trx, employerUserId);

    return trx
      .selectFrom('employer_wallets')
      .select(['balance_coins', 'registration_bonus_at'])
      .where('user_id', '=', employerUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  private async ensureWallet(
    db: Database | Transaction<DB>,
    employerUserId: string,
  ): Promise<{ balance_coins: number; registration_bonus_at: Date | null }> {
    await db
      .insertInto('employer_wallets')
      .values({ user_id: employerUserId })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .execute();

    return db
      .selectFrom('employer_wallets')
      .select(['balance_coins', 'registration_bonus_at'])
      .where('user_id', '=', employerUserId)
      .executeTakeFirstOrThrow();
  }

  private async setBalance(
    trx: Transaction<DB>,
    employerUserId: string,
    balanceCoins: number,
  ): Promise<void> {
    await trx
      .updateTable('employer_wallets')
      .set({ balance_coins: balanceCoins, updated_at: sql`now()` })
      .where('user_id', '=', employerUserId)
      .execute();
  }
}
