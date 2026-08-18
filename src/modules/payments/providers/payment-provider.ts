import type {
  LocaleCode,
  PaymentOrderStatus,
  PaymentProvider as PaymentProviderId,
} from '@infra/db/database.types';

export type { PaymentProviderId };

/** What a provider needs in order to build a checkout the employer can open. */
export interface CheckoutOrder {
  /** The internal Payment Order id (§6.7). Both providers carry it back to us. */
  id: string;
  coins: number;
  amountUzs: number;
  /** For the provider's own checkout page, where it supports one. */
  locale: LocaleCode;
}

/**
 * How the client opens the provider's checkout.
 *
 * A URL and nothing else. §6.7 allows "a provider-approved checkout, payment link, deep
 * link, or supported SDK flow" and forbids the app from collecting card data, so the app's
 * whole job is to open this and wait for our own status to change.
 */
export interface CheckoutInstruction {
  provider: PaymentProviderId;
  url: string;
  /** Repeated here so the client displays the amount the provider will actually charge. */
  amountUzs: number;
}

/** An inbound provider request, before any part of it is trusted. */
export interface CallbackRequest {
  /** Lower-cased header names. Payme authenticates here; CLICK does not. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON for Payme, form fields for CLICK. Unknown until the adapter reads it. */
  body: unknown;
}

/**
 * What the provider is asking for, in this system's vocabulary rather than its own.
 *
 * Six Payme methods (§12.6) and CLICK's two collapse to these, which is the point of
 * having them: `PerformTransaction` and `Complete` mean the same thing to a wallet, and
 * only the wire format differs.
 */
export type ProviderCommand =
  /** May this order be paid at this amount? Changes nothing (Payme CheckPerformTransaction). */
  | { kind: 'check'; orderId: string; amountUzs: number }
  /** The provider has opened a transaction against the order (Payme CreateTransaction, CLICK Prepare). */
  | {
      kind: 'create';
      orderId: string;
      amountUzs: number;
      providerTransactionId: string;
    }
  /** The money has arrived - the only command that credits (Payme PerformTransaction, CLICK Complete). */
  | {
      kind: 'perform';
      providerTransactionId: string;
      /** CLICK sends the order back on `Complete`; Payme does not, so this may be null. */
      orderId: string | null;
      amountUzs: number | null;
    }
  /**
   * Cancelled or refunded by the provider (Payme CancelTransaction, CLICK reporting its own
   * error). `orderId` is carried where the provider sends it, because a CLICK `Prepare` that
   * fails is a cancellation of an order whose transaction id was never stored.
   */
  | {
      kind: 'cancel';
      providerTransactionId: string;
      orderId: string | null;
      reason: string | null;
    }
  /** A status poll. Changes nothing (Payme CheckTransaction). */
  | { kind: 'status'; providerTransactionId: string }
  /** Reconciliation over a date range (Payme GetStatement). Changes nothing. */
  | { kind: 'statement'; fromMs: number; toMs: number };

/** What every parsed callback carries, verified or not. */
export interface ParsedCallbackBase {
  /** The provider's own method name, recorded on the event whatever happens next. */
  method: string;
  /**
   * The provider's request correlation id, echoed back where the protocol wants it.
   *
   * Payme is JSON-RPC and requires it; CLICK has no equivalent and leaves it null. It is
   * carried on the parsed callback rather than dug out again at render time, because
   * rendering happens after the transaction and must not re-read the request.
   */
  requestId: string | number | null;
}

/**
 * The result of reading one callback.
 *
 * **Verification is part of parsing, not a later step.** §12.6 requires provider
 * credentials and signatures to be checked "before changing the internal Payment Order
 * state", and a type that cannot hand back a command without having verified it is how
 * that ordering stops being a convention. `verified: false` carries no command, so there
 * is nothing for a caller to act on by mistake.
 */
export type ParsedCallback = VerifiedCallback | RejectedCallback;

export type VerifiedCallback = ParsedCallbackBase & {
  verified: true;
  command: ProviderCommand;
};

export type RejectedCallback = ParsedCallbackBase & {
  verified: false;
  detail: RejectionCode;
};

/** Why a callback was refused. Stable, machine-readable, and recorded on the event. */
export type RejectionCode =
  | 'invalid_signature'
  | 'provider_not_configured'
  | 'unknown_method'
  | 'malformed_request';

/** Why a verified command could not be carried out. */
export type CommandErrorCode =
  | 'order_not_found'
  | 'invalid_amount'
  | 'order_not_payable'
  | 'transaction_not_found'
  | 'already_cancelled';

/** The order as a provider response needs to see it. Times are epoch milliseconds. */
export interface OrderSnapshot {
  id: string;
  status: PaymentOrderStatus;
  coins: number;
  amountUzs: number;
  providerTransactionId: string | null;
  createdAtMs: number;
  paidAtMs: number | null;
  /**
   * When the order last moved. Payme's `CheckTransaction` wants a cancel time, and for a
   * cancelled or reversed order this is it - the cancellation is the last thing that
   * happened to it. A dedicated column would exist only to satisfy one provider's
   * response format.
   */
  updatedAtMs: number;
}

/** What the service decided, for the adapter to render in the provider's own format. */
export type CommandOutcome =
  /** The order is payable. It carries the order because Payme's answer may include a receipt. */
  | { ok: true; kind: 'check'; order: OrderSnapshot }
  | { ok: true; kind: 'created'; order: OrderSnapshot }
  | { ok: true; kind: 'performed'; order: OrderSnapshot }
  | { ok: true; kind: 'cancelled'; order: OrderSnapshot }
  | { ok: true; kind: 'status'; order: OrderSnapshot }
  | { ok: true; kind: 'statement'; orders: OrderSnapshot[] }
  | { ok: false; code: CommandErrorCode };

/** A rendered response, ready to return to the provider. */
export interface ProviderResponse {
  /**
   * Both providers signal failure in the body and expect 200. A 4xx would make a provider
   * retry a request we have already decided about, so the status code is theirs to want,
   * not ours to choose.
   */
  status: number;
  body: unknown;
}

/**
 * The seam a payment provider plugs into (§6.7, §12.6, §12.7).
 *
 * The third of these in the product, after `SmsSender` and `PushSender`, and the same
 * shape for the same reason: the flow has to be complete and testable before a merchant
 * account exists, and the day the credentials arrive should change configuration rather
 * than code.
 *
 * **The adapter owns the wire format; the service owns the state machine.** That split is
 * what makes BR-19 provable: if a provider adapter could move an order, exactly-once
 * crediting would be a property each of them had to get right separately. Instead an
 * adapter translates in both directions and never touches the database, so
 * `PaymentOrdersService` holds the only transitions in the milestone and the tests that
 * cover them cover both providers.
 *
 * **There is no outbound HTTP here, and that is not an omission.** Both integrations are
 * inbound: Payme's Merchant API calls *us* with all six of §12.6's methods, and CLICK's
 * Shop API calls *us* with `Prepare` and `Complete`. Checkout is a URL the client opens.
 * So there is no HTTP client, no timeout policy and no retry policy in this milestone -
 * the provider retries, and BR-19 is what makes that safe.
 *
 * **An unconfigured adapter refuses rather than pretends**, the rule `LoggingSmsSender`
 * follows. It is enforced by construction here rather than by a separate no-op class:
 * verifying a Payme request needs the merchant key and verifying a CLICK request needs the
 * secret, so with no credentials there is no code path that can return `verified: true`.
 * `configured` is what the registry filters on so an employer is never offered a checkout
 * that cannot be honoured.
 *
 * §12.7 asks for the ledger to stay provider-agnostic so that a store build can substitute
 * Apple IAP or Google Play Billing without changing Candidate Unlock. What that costs is
 * visible from this file: a fourth implementation, one `ALTER TYPE ... ADD VALUE`, and
 * nothing else - `wallet_transactions` has no provider column, and the unlock never reads
 * one.
 */
export abstract class PaymentProvider {
  abstract readonly id: PaymentProviderId;

  /** False when this deployment holds no credentials for the provider. */
  abstract readonly configured: boolean;

  /** The URL the client opens. Only ever called for a configured provider. */
  abstract checkout(order: CheckoutOrder): CheckoutInstruction;

  /** Reads and verifies one inbound request. Pure: it touches nothing. */
  abstract parse(request: CallbackRequest): ParsedCallback;

  /** Renders the service's decision in the provider's own format. Also pure. */
  abstract render(
    callback: VerifiedCallback,
    outcome: CommandOutcome,
  ): ProviderResponse;

  /** How a refused callback is answered. Separate, because there is no outcome to render. */
  abstract renderRejection(callback: RejectedCallback): ProviderResponse;
}
