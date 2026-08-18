import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { timingSafeEquals } from '@infra/crypto/hash';
import type { AppEnv } from '@infra/env-schema';

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

/** CLICK's two actions, as integers on the wire. */
const CLICK_ACTION = { prepare: 0, complete: 1 } as const;

/**
 * CLICK's error integers, which are its whole failure vocabulary.
 *
 * Fixed protocol strings again, not user-facing text: nothing here reads `x-lang` and none
 * of it reaches a screen.
 */
const CLICK_ERROR: Record<CommandErrorCode, { error: number; note: string }> = {
  order_not_found: { error: -5, note: 'Order not found' },
  invalid_amount: { error: -2, note: 'Incorrect amount' },
  order_not_payable: { error: -4, note: 'Already paid' },
  transaction_not_found: { error: -6, note: 'Transaction does not exist' },
  already_cancelled: { error: -9, note: 'Transaction cancelled' },
};

const CLICK_SIGN_FAILED = { error: -1, note: 'SIGN CHECK FAILED' };
const CLICK_BAD_REQUEST = { error: -8, note: 'Error in request from CLICK' };

/** The CLICK request fields this reads. Sent form-encoded, so every value is a string. */
interface ClickRequest {
  click_trans_id?: unknown;
  service_id?: unknown;
  merchant_trans_id?: unknown;
  merchant_prepare_id?: unknown;
  amount?: unknown;
  action?: unknown;
  error?: unknown;
  error_note?: unknown;
  sign_time?: unknown;
  sign_string?: unknown;
}

/**
 * CLICK Shop API (§6.7, §12.6).
 *
 * Two inbound callbacks, `Prepare` and `Complete`, both authenticated by an MD5 signature
 * over a fixed field order with the merchant secret in the middle. MD5 is CLICK's choice,
 * not ours - it is what their sign string is specified as, and the alternative is not
 * integrating.
 *
 * Three things about the protocol are worth knowing before editing this.
 *
 * - **The signed field list differs between the two actions.** `Complete` includes
 *   `merchant_prepare_id` and `Prepare` does not, so one signature routine with a
 *   conditional field is the whole difference; getting it wrong produces "SIGN CHECK
 *   FAILED" on exactly half the traffic.
 * - **`merchant_prepare_id` is a value we choose and CLICK echoes.** It is derived from the
 *   order id rather than stored: a deterministic function of the id needs no column and no
 *   second write, and because the signature covers it, a `Complete` naming a different one
 *   fails verification rather than being quietly accepted.
 * - **CLICK reports its own failures in the request.** A `Complete` carrying a negative
 *   `error` is a cancellation, so it maps to `cancel` rather than `perform` - which is what
 *   makes BR-20 hold for this provider: the credit path is never entered at all.
 *
 * With no secret configured there is nothing to sign against, so `parse` cannot return a
 * verified command.
 */
@Injectable()
export class ClickProvider extends PaymentProvider {
  readonly id: PaymentProviderId = 'click';

  private readonly merchantId: string;
  private readonly serviceId: string;
  private readonly secretKey: string;
  private readonly checkoutUrl: string;

  constructor(config: ConfigService<AppEnv, true>) {
    super();

    this.merchantId = config.get('CLICK_MERCHANT_ID', { infer: true });
    this.serviceId = config.get('CLICK_SERVICE_ID', { infer: true });
    this.secretKey = config.get('CLICK_SECRET_KEY', { infer: true });
    this.checkoutUrl = config.get('CLICK_CHECKOUT_URL', { infer: true });
  }

  get configured(): boolean {
    return (
      this.merchantId !== '' && this.serviceId !== '' && this.secretKey !== ''
    );
  }

  /**
   * CLICK's payment link.
   *
   * `transaction_param` is the field CLICK carries back as `merchant_trans_id`, so it holds
   * the internal order id. No secret appears in the URL (BR-22).
   */
  checkout(order: CheckoutOrder): CheckoutInstruction {
    const query = new URLSearchParams({
      service_id: this.serviceId,
      merchant_id: this.merchantId,
      amount: order.amountUzs.toFixed(2),
      transaction_param: order.id,
    });

    return {
      provider: this.id,
      url: `${this.checkoutUrl}?${query.toString()}`,
      amountUzs: order.amountUzs,
    };
  }

  parse(request: CallbackRequest): ParsedCallback {
    const body = (request.body ?? {}) as ClickRequest;
    const action = asNumber(body.action);
    const method =
      action === CLICK_ACTION.prepare
        ? 'Prepare'
        : action === CLICK_ACTION.complete
          ? 'Complete'
          : 'unknown';
    // CLICK is not JSON-RPC and has no request id to echo.
    const base = { method, requestId: null };

    if (!this.configured) {
      return { ...base, verified: false, detail: 'provider_not_configured' };
    }

    if (method === 'unknown') {
      return { ...base, verified: false, detail: 'unknown_method' };
    }

    const clickTransId = asPlainString(body.click_trans_id);
    const orderId = asPlainString(body.merchant_trans_id);
    const amount = asNumber(body.amount);
    const signTime = asPlainString(body.sign_time);
    const signature = asPlainString(body.sign_string);
    const prepareId = asPlainString(body.merchant_prepare_id);

    if (
      clickTransId === null ||
      orderId === null ||
      amount === null ||
      signTime === null ||
      signature === null ||
      (method === 'Complete' && prepareId === null)
    ) {
      return { ...base, verified: false, detail: 'malformed_request' };
    }

    const expected = this.sign({
      clickTransId,
      orderId,
      prepareId: method === 'Complete' ? prepareId : null,
      // Signed as CLICK sent it, not as a number: `1000.00` and `1000` hash differently,
      // and re-formatting the value would break every signature.
      amount: asPlainString(body.amount) ?? '',
      action: String(action),
      signTime,
    });

    if (!timingSafeEquals(signature.toLowerCase(), expected)) {
      return { ...base, verified: false, detail: 'invalid_signature' };
    }

    // §12.6: verify the merchant parameters, not only the signature. A signature made with
    // our secret for a different service id is still not our transaction.
    if (asPlainString(body.service_id) !== this.serviceId) {
      return { ...base, verified: false, detail: 'invalid_signature' };
    }

    if (method === 'Complete' && prepareId !== this.prepareId(orderId)) {
      return { ...base, verified: false, detail: 'malformed_request' };
    }

    // CLICK's own failure, reported in the request it sends us. Never a credit (BR-20).
    const reportedError = asNumber(body.error) ?? 0;

    if (reportedError < 0) {
      return {
        ...base,
        verified: true,
        command: {
          kind: 'cancel',
          providerTransactionId: clickTransId,
          // CLICK re-sends the order, so a failed `Prepare` - whose transaction id was
          // never stored - can still be matched to what it cancelled.
          orderId,
          reason: asPlainString(body.error_note) ?? String(reportedError),
        },
      };
    }

    return method === 'Prepare'
      ? {
          ...base,
          verified: true,
          command: {
            kind: 'create',
            orderId,
            amountUzs: amount,
            providerTransactionId: clickTransId,
          },
        }
      : {
          ...base,
          verified: true,
          command: {
            kind: 'perform',
            providerTransactionId: clickTransId,
            // Unlike Payme, CLICK re-sends the order and the amount on completion, so both
            // are re-checked against the order before anything is credited.
            orderId,
            amountUzs: amount,
          },
        };
  }

  render(
    callback: VerifiedCallback,
    outcome: CommandOutcome,
  ): ProviderResponse {
    if (!outcome.ok) {
      return this.body(callback, CLICK_ERROR[outcome.code]);
    }

    switch (outcome.kind) {
      case 'created':
        return this.body(
          callback,
          { error: 0, note: 'Success' },
          outcome.order,
        );

      case 'performed':
        return this.body(
          callback,
          { error: 0, note: 'Success' },
          outcome.order,
        );

      case 'cancelled':
        return this.body(
          callback,
          { error: 0, note: 'Cancelled' },
          outcome.order,
        );

      // CLICK has no check, status or statement call - those are Payme's. Reaching one here
      // would mean the parser produced a command this provider cannot ask for.
      default:
        return this.body(callback, CLICK_BAD_REQUEST);
    }
  }

  renderRejection(callback: RejectedCallback): ProviderResponse {
    return this.body(
      callback,
      callback.detail === 'invalid_signature' ||
        callback.detail === 'provider_not_configured'
        ? CLICK_SIGN_FAILED
        : CLICK_BAD_REQUEST,
    );
  }

  /**
   * CLICK's response envelope.
   *
   * `merchant_confirm_id` on a completion and `merchant_prepare_id` on a preparation are
   * what CLICK matches its side against, so both are derived from the order id - the same
   * function, so the value CLICK signs on `Complete` is the value it was given on
   * `Prepare`.
   */
  private body(
    callback: ParsedCallback,
    result: { error: number; note: string },
    order?: OrderSnapshot,
  ): ProviderResponse {
    const payload: Record<string, unknown> = {
      error: result.error,
      error_note: result.note,
    };

    if (order) {
      payload.merchant_trans_id = order.id;

      if (callback.method === 'Prepare') {
        payload.merchant_prepare_id = this.prepareId(order.id);
      } else {
        payload.merchant_confirm_id = this.prepareId(order.id);
      }
    }

    // 200 even for a refusal: CLICK reads the `error` field, and an HTTP error would make
    // it retry a request already answered.
    return { status: 200, body: payload };
  }

  /** The MD5 sign string, in CLICK's field order. */
  private sign(fields: {
    clickTransId: string;
    orderId: string;
    prepareId: string | null;
    amount: string;
    action: string;
    signTime: string;
  }): string {
    const parts = [
      fields.clickTransId,
      this.serviceId,
      this.secretKey,
      fields.orderId,
      // Present for `Complete`, absent for `Prepare`. This single difference is the whole
      // distinction between the two signatures.
      ...(fields.prepareId === null ? [] : [fields.prepareId]),
      fields.amount,
      fields.action,
      fields.signTime,
    ];

    return createHash('md5').update(parts.join(''), 'utf8').digest('hex');
  }

  /**
   * The `merchant_prepare_id` for an order: deterministic, and derived rather than stored.
   *
   * CLICK wants an integer it can echo, and our order id is a UUID. Taking the first eight
   * hex digits gives a stable number for the order with no column, no second write and
   * nothing to look up on `Complete` - and since the signature covers the value, a
   * completion naming a different one fails verification instead of being accepted.
   *
   * It is not required to be globally unique: it identifies the preparation *of this
   * order*, which the accompanying `merchant_trans_id` already names.
   */
  private prepareId(orderId: string): string {
    return String(Number.parseInt(orderId.replace(/-/g, '').slice(0, 8), 16));
  }
}

/** A form field that must be present and non-empty. */
function asPlainString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  // Form bodies are strings, but a JSON-posting test or a proxy may hand over a number.
  return typeof value === 'number' ? String(value) : null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);

  return typeof value === 'string' || typeof value === 'number'
    ? Number.isFinite(parsed)
      ? parsed
      : null
    : null;
}
