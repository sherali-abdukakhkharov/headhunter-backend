import type { LocaleCode } from '@infra/db/database.types';

/**
 * One push, already rendered.
 *
 * Rendered here and not in the sender, because the language is a property of the *user*
 * and the sender's job is transport. The in-app row still stores a key (see the
 * migration) - this is the copy that goes out at that moment, in whatever language the
 * recipient had set when it was sent.
 */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** The deep link, as string data - FCM's payload is string-to-string. */
  data: Record<string, string>;
  locale: LocaleCode;
}

/**
 * What happened to one token.
 *
 * `invalid` is the case that matters operationally: FCM answers `UNREGISTERED` or
 * `INVALID_ARGUMENT` for a token belonging to an app that was uninstalled, and a
 * dispatcher that ignored it would retry a dead device for ever.
 */
export interface PushResult {
  token: string;
  status: 'sent' | 'invalid' | 'failed';
  error?: string;
}

/**
 * The seam a provider plugs into (§9.2).
 *
 * One interface with two implementations - the FCM sender and a no-op - for the same
 * reason `OTP_STATIC_CODE` exists on the OTP path: the product has to be complete and
 * testable before a third-party account exists, and the day the credential arrives must
 * change configuration rather than code.
 *
 * Deliberately narrow. It knows nothing about notifications, preferences or users; it
 * takes rendered messages and reports what each token did.
 */
export abstract class PushSender {
  abstract send(messages: PushMessage[]): Promise<PushResult[]>;
}
