import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { timingSafeEquals } from '@infra/crypto/hash';
import type { AppEnv } from '@infra/env-schema';

import { fiscalDetail } from '../payment-fiscal';
import {
  type CallbackRequest,
  type CheckoutInstruction,
  type CheckoutOrder,
  type CommandErrorCode,
  type CommandOutcome,
  type OrderSnapshot,
  type ParsedCallback,
  PaymentProvider,
  type PaymentProviderId,
  type ProviderResponse,
  type RejectedCallback,
  type VerifiedCallback,
} from './payment-provider';

/** Payme's transaction states, which are not ours (§12.6). */
const PAYME_STATE = {
  created: 1,
  performed: 2,
  cancelled: -1,
  cancelledAfterPerform: -2,
} as const;

/**
 * Payme's own error codes, and the fixed message each carries.
 *
 * These are **protocol strings, not user-facing text**, which is why they are here rather
 * than in `infra/i18n/messages.ts`. Payme's envelope requires a `{ru, uz, en}` object, and
 * a provider is not a person: nothing here reads `x-lang`, and none of it ever reaches a
 * screen. Putting them in the message catalogue would put four-locale keys nobody renders
 * next to the ones that are rendered.
 */
const PAYME_ERROR: Record<
  CommandErrorCode,
  { code: number; message: { ru: string; uz: string; en: string } }
> = {
  order_not_found: {
    // Payme reserves -31050..-31099 for account errors, and the order id is the account.
    code: -31050,
    message: {
      ru: 'Заказ не найден',
      uz: 'Buyurtma topilmadi',
      en: 'Order not found',
    },
  },
  invalid_amount: {
    code: -31001,
    message: {
      ru: 'Неверная сумма',
      uz: 'Summa xato',
      en: 'Invalid amount',
    },
  },
  order_not_payable: {
    code: -31008,
    message: {
      ru: 'Операция невозможна',
      uz: 'Amalni bajarish mumkin emas',
      en: 'Operation is not possible',
    },
  },
  transaction_not_found: {
    code: -31003,
    message: {
      ru: 'Транзакция не найдена',
      uz: 'Tranzaksiya topilmadi',
      en: 'Transaction not found',
    },
  },
  already_cancelled: {
    code: -31007,
    message: {
      ru: 'Транзакция уже отменена',
      uz: 'Tranzaksiya allaqachon bekor qilingan',
      en: 'Transaction is already cancelled',
    },
  },
};

/** The Payme request shape, as far as this reads it. Everything else is ignored. */
interface PaymeRequest {
  method?: unknown;
  id?: unknown;
  params?: {
    id?: unknown;
    amount?: unknown;
    account?: Record<string, unknown>;
    reason?: unknown;
    from?: unknown;
    to?: unknown;
  };
}

/**
 * Payme Merchant API (§6.7, §12.6).
 *
 * All six methods §12.6 names are **inbound**: Payme's server calls this API, and there is
 * no outbound call to make. Checkout is a URL built from the merchant id and the amount,
 * which is why this class holds no HTTP client at all.
 *
 * Three properties of the protocol shape the code.
 *
 * - **Amounts are in tiyin**, 1/100 of a soum, and the conversion is the single most
 *   likely place in this milestone to be wrong by two orders of magnitude. It happens in
 *   `toTiyin`/`fromTiyin` and nowhere else, and a unit test pins both directions.
 * - **Authentication is HTTP Basic with a fixed username**, `Paycom`, and the merchant key
 *   as the password. The comparison is length-safe and constant-time, because a callback
 *   endpoint is public and an attacker can call it as often as they like.
 * - **The account field is merchant configuration.** Payme is told which field name carries
 *   our order id when the cash-box is set up, so it is a variable here
 *   (`PAYME_ACCOUNT_FIELD`) rather than a literal - getting it wrong makes every callback
 *   fail with "order not found", which is a confusing way to discover a naming mismatch.
 *
 * With no merchant key configured, `parse` cannot return a verified command: there is
 * nothing to compare the Basic credential against. That is the `LoggingSmsSender` rule
 * arriving by construction rather than by a separate class.
 */
@Injectable()
export class PaymeProvider extends PaymentProvider {
  readonly id: PaymentProviderId = 'payme';

  private readonly merchantId: string;
  private readonly merchantKey: string;
  private readonly checkoutUrl: string;
  private readonly accountField: string;

  constructor(config: ConfigService<AppEnv, true>) {
    super();

    this.merchantId = config.get('PAYME_MERCHANT_ID', { infer: true });
    this.merchantKey = config.get('PAYME_MERCHANT_KEY', { infer: true });
    this.checkoutUrl = config.get('PAYME_CHECKOUT_URL', { infer: true });
    this.accountField = config.get('PAYME_ACCOUNT_FIELD', { infer: true });
  }

  get configured(): boolean {
    return this.merchantId !== '' && this.merchantKey !== '';
  }

  /**
   * Payme's checkout link: one base64 parameter string, per its GET-checkout form.
   *
   * `m` is the merchant id, `ac.<field>` the account, `a` the amount in tiyin and `l` the
   * language. No secret is involved - the merchant key only ever authenticates inbound
   * callbacks - so this URL is safe to hand to a client, which is what BR-22 requires.
   */
  checkout(order: CheckoutOrder): CheckoutInstruction {
    const params = [
      `m=${this.merchantId}`,
      `ac.${this.accountField}=${order.id}`,
      `a=${toTiyin(order.amountUzs)}`,
      `l=${order.locale}`,
    ].join(';');

    return {
      provider: this.id,
      url: `${this.checkoutUrl}/${Buffer.from(params, 'utf8').toString('base64')}`,
      amountUzs: order.amountUzs,
    };
  }

  parse(request: CallbackRequest): ParsedCallback {
    const body = (request.body ?? {}) as PaymeRequest;
    const method = typeof body.method === 'string' ? body.method : 'unknown';
    const requestId =
      typeof body.id === 'string' || typeof body.id === 'number'
        ? body.id
        : null;
    const base = { method, requestId };

    if (!this.configured) {
      return { ...base, verified: false, detail: 'provider_not_configured' };
    }

    if (!this.authorized(request.headers.authorization)) {
      return { ...base, verified: false, detail: 'invalid_signature' };
    }

    const params = body.params ?? {};
    const account = params.account ?? {};
    const orderId = asString(account[this.accountField]);
    const transactionId = asString(params.id);
    const amountUzs =
      typeof params.amount === 'number' ? fromTiyin(params.amount) : null;

    switch (method) {
      case 'CheckPerformTransaction':
        return orderId !== null && amountUzs !== null
          ? {
              ...base,
              verified: true,
              command: { kind: 'check', orderId, amountUzs },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      case 'CreateTransaction':
        return orderId !== null && amountUzs !== null && transactionId !== null
          ? {
              ...base,
              verified: true,
              command: {
                kind: 'create',
                orderId,
                amountUzs,
                providerTransactionId: transactionId,
              },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      case 'PerformTransaction':
        return transactionId !== null
          ? {
              ...base,
              verified: true,
              command: {
                kind: 'perform',
                providerTransactionId: transactionId,
                // Payme's `PerformTransaction` carries only its own transaction id, so the
                // order is found by that. The amount is not re-sent and is therefore not
                // re-checked here - it was checked on `CheckPerformTransaction` and on
                // `CreateTransaction`, against the same order.
                orderId: null,
                amountUzs: null,
              },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      case 'CancelTransaction':
        return transactionId !== null
          ? {
              ...base,
              verified: true,
              command: {
                kind: 'cancel',
                providerTransactionId: transactionId,
                // Payme identifies the transaction and never re-sends the account.
                orderId: null,
                reason: asReason(params.reason),
              },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      case 'CheckTransaction':
        return transactionId !== null
          ? {
              ...base,
              verified: true,
              command: { kind: 'status', providerTransactionId: transactionId },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      case 'GetStatement':
        return typeof params.from === 'number' && typeof params.to === 'number'
          ? {
              ...base,
              verified: true,
              command: {
                kind: 'statement',
                fromMs: params.from,
                toMs: params.to,
              },
            }
          : { ...base, verified: false, detail: 'malformed_request' };

      default:
        return { ...base, verified: false, detail: 'unknown_method' };
    }
  }

  render(
    callback: VerifiedCallback,
    outcome: CommandOutcome,
  ): ProviderResponse {
    if (!outcome.ok) {
      return this.error(callback.requestId, PAYME_ERROR[outcome.code]);
    }

    switch (outcome.kind) {
      case 'check':
        return this.result(callback.requestId, {
          allow: true,
          // §6.7's fiscal receipt goes here, and only once somebody has supplied the codes.
          // `receipt()` returns nothing while they are unknown, so Payme sees no `detail`
          // field at all rather than one carrying an engineer's placeholder tax code.
          ...receipt(outcome.order),
        });

      case 'created':
        return this.result(callback.requestId, {
          create_time: outcome.order.createdAtMs,
          transaction: outcome.order.id,
          state: PAYME_STATE.created,
        });

      case 'performed':
        return this.result(callback.requestId, {
          perform_time: outcome.order.paidAtMs ?? 0,
          transaction: outcome.order.id,
          state: PAYME_STATE.performed,
        });

      case 'cancelled':
        return this.result(callback.requestId, {
          cancel_time: outcome.order.updatedAtMs,
          transaction: outcome.order.id,
          state: cancelState(outcome.order),
        });

      case 'status':
        return this.result(callback.requestId, this.transaction(outcome.order));

      case 'statement':
        return this.result(callback.requestId, {
          transactions: outcome.orders.map((order) => this.transaction(order)),
        });
    }
  }

  renderRejection(callback: RejectedCallback): ProviderResponse {
    // -32504 is Payme's "insufficient privileges" - the right answer to a request that
    // failed authentication - and -32300 its transport-level error for anything it sent
    // that this cannot read. Neither reveals whether the order exists.
    const code =
      callback.detail === 'invalid_signature' ||
      callback.detail === 'provider_not_configured'
        ? -32504
        : -32300;

    return this.error(callback.requestId, {
      code,
      message: {
        ru: 'Запрос отклонён',
        uz: 'Soʻrov rad etildi',
        en: 'Request rejected',
      },
    });
  }

  /** Payme's transaction record, shared by `CheckTransaction` and `GetStatement`. */
  private transaction(order: OrderSnapshot): Record<string, unknown> {
    const cancelled =
      order.status === 'cancelled' ||
      order.status === 'failed' ||
      order.status === 'reversed';

    return {
      create_time: order.createdAtMs,
      perform_time: order.paidAtMs ?? 0,
      cancel_time: cancelled ? order.updatedAtMs : 0,
      transaction: order.id,
      state: paymeState(order),
      reason: null,
    };
  }

  private result(
    requestId: string | number | null,
    result: Record<string, unknown>,
  ): ProviderResponse {
    return { status: 200, body: { result, id: requestId } };
  }

  private error(
    requestId: string | number | null,
    error: { code: number; message: Record<string, string> },
  ): ProviderResponse {
    // 200 with an error body, which is what Payme expects: an HTTP error would make it
    // retry a request that has already been answered.
    return { status: 200, body: { error, id: requestId } };
  }

  /**
   * Payme's Basic credential: the fixed username `Paycom` and the merchant key.
   *
   * Compared with a constant-time comparison over equal-length buffers. This route is
   * public by necessity, so the comparison is one an attacker can call repeatedly, and a
   * length check first keeps `timingSafeEqual` from throwing on a short string.
   */
  private authorized(header: string | undefined): boolean {
    if (header === undefined || !header.startsWith('Basic ')) {
      return false;
    }

    const decoded = Buffer.from(
      header.slice('Basic '.length),
      'base64',
    ).toString('utf8');
    const separator = decoded.indexOf(':');

    if (separator === -1 || decoded.slice(0, separator) !== 'Paycom') {
      return false;
    }

    return timingSafeEquals(decoded.slice(separator + 1), this.merchantKey);
  }
}

/**
 * Payme's fiscal receipt block, or nothing at all (§6.7).
 *
 * Payme carries the receipt in `CheckPerformTransaction`'s `detail`, which is why this is the
 * one place it can be attached. The attributes are declared in `payment-fiscal.ts` and are
 * **unknown until the client's accounting function supplies them**, so today this returns an
 * empty object and the field is simply absent - a receipt with a guessed IKPU code on a real
 * transaction is worse than no receipt, and it is worse in a way that ends up on a tax
 * return rather than in a log.
 *
 * Amounts here are in tiyin, like every other amount Payme handles.
 */
function receipt(order: OrderSnapshot): { detail?: Record<string, unknown> } {
  const fiscal = fiscalDetail();

  if (!fiscal) {
    return {};
  }

  return {
    detail: {
      // 0 is Payme's "sale" receipt type.
      receipt_type: 0,
      items: [
        {
          title: `${order.coins} Coins`,
          price: toTiyin(order.amountUzs / order.coins),
          count: order.coins,
          code: fiscal.productCode,
          package_code: fiscal.packageCode,
          vat_percent: fiscal.vatPercent,
          units: fiscal.unitCode,
        },
      ],
    },
  };
}

/** Payme's state for an order, as its own protocol numbers it. */
function paymeState(order: OrderSnapshot): number {
  switch (order.status) {
    case 'paid':
      return PAYME_STATE.performed;
    case 'reversed':
      return PAYME_STATE.cancelledAfterPerform;
    case 'cancelled':
    case 'failed':
      return PAYME_STATE.cancelled;
    default:
      return PAYME_STATE.created;
  }
}

/**
 * -1 or -2, which Payme distinguishes and we do not.
 *
 * A cancellation before the money moved is -1; a refund of money that did move is -2. Our
 * `reversed` status is exactly the second case, which is why the two collapse into one
 * column here without losing the distinction the provider needs.
 */
function cancelState(order: OrderSnapshot): number {
  return order.status === 'reversed'
    ? PAYME_STATE.cancelledAfterPerform
    : PAYME_STATE.cancelled;
}

/**
 * Soum to tiyin, and back. §12.6: "Payme amounts are handled in tiyin."
 *
 * Both directions are here so the factor of 100 appears twice in one place instead of
 * wherever an amount is read. `Math.round` because a soum amount arrives as a
 * `numeric(14,2)` and floating point cannot be trusted to land on an integer.
 */
export function toTiyin(amountUzs: number): number {
  return Math.round(amountUzs * 100);
}

export function fromTiyin(tiyin: number): number {
  return tiyin / 100;
}

/**
 * Payme's cancellation reason, which its documentation defines as an integer code.
 *
 * Narrowed rather than stringified, because this value is written to `payment_orders.
 * failure_code` and shown to the employer as the reason their payment did not complete.
 * `String()` on an untrusted `unknown` puts `[object Object]` on that screen for anything
 * that is not a scalar, and a callback body is untrusted by definition.
 */
function asReason(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : null;
}

/** A provider field that must be a non-empty string to be usable. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
