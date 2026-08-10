import type { LocaleCode } from '@infra/db/database.types';

/** One message, already rendered in the recipient's language. */
export interface SmsMessage {
  /** E.164, as `normalizePhone` produces it. The sender strips the `+` if it must. */
  phone: string;
  text: string;
  /** Carried for the provider's template matching and for logging, never rendered. */
  locale: LocaleCode;
}

/**
 * What happened to one message.
 *
 * There is no `queued`. From this API's point of view a message is either accepted by
 * the provider or it is not, and "probably sent" is the state that makes a user stare at
 * a code-entry screen for a code that will never arrive.
 */
export interface SmsResult {
  status: 'sent' | 'failed';
  /** The provider's own id, kept for a support conversation about one message. */
  providerMessageId?: string;
  /** Short, machine-readable, safe to log. Never the message text. */
  error?: string;
}

/**
 * The seam an SMS provider plugs into (§4.1, docs/SMS_PROVIDER.md).
 *
 * The same shape as `PushSender`, for the same reason: the product has to be complete and
 * testable before a third-party account exists, and the day the credential arrives should
 * change configuration rather than code. `EskizSmsSender` is the real one;
 * `LoggingSmsSender` is what runs until an account is bought.
 *
 * Deliberately narrow. It knows nothing about OTPs, users or purposes - it takes rendered
 * text and reports what happened to it. That is what keeps the login flow's rules (TTL,
 * supersession, attempt limits) entirely in `OtpService`, where they are already tested.
 */
export abstract class SmsSender {
  abstract send(message: SmsMessage): Promise<SmsResult>;
}
