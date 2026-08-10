import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@infra/env-schema';
import { maskPhone } from '@infra/phone/phone';

import { type SmsMessage, type SmsResult, SmsSender } from './sms-sender';

/** The subset of Eskiz's send response this reads. Everything else is ignored. */
interface EskizSendResponse {
  id?: string | number;
  message?: string;
  status?: string;
}

/**
 * SMS delivery through Eskiz.uz (§4.1, client direction 2026-08-05).
 *
 * Written against the shapes in [docs/SMS_PROVIDER.md](../../../../docs/SMS_PROVIDER.md),
 * which were read from Eskiz's generated client rather than from the vendor's own
 * document - the vendor page is a JavaScript-rendered Postman collection. **The paths are
 * reliable; the body field spelling is the part to re-check against the dashboard on
 * purchase.** Nothing here has been run against a real account, because there is not one
 * yet, and that is stated rather than implied.
 *
 * Three things about the provider shape the code.
 *
 * - **The token is a login, not a given secret.** It is obtained with the account email
 *   and password and expires, so a 401 means re-login rather than fail. A token that
 *   expired mid-flight must never become a user-visible login failure, which is why
 *   `send` retries exactly once after re-authenticating - and exactly once, because a
 *   loop against an account with a wrong password is a lockout.
 * - **Message text is approved, not free-form.** A fresh account is in test mode where
 *   only three exact strings are accepted. The text arrives already rendered from
 *   `otp-message.ts`; when a template is approved this class does not change.
 * - **The originator is account configuration**, not ours to choose per message.
 *
 * No retries beyond the one re-authentication, and no queue: `OtpService` treats a failed
 * send as a failed send and removes the code, so the user's own retry is the recovery.
 * A queue behind a login screen would deliver a code after the user gave up.
 */
@Injectable()
export class EskizSmsSender extends SmsSender {
  private readonly logger = new Logger(EskizSmsSender.name);

  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly from: string;
  private readonly timeoutMs: number;

  /** Held in memory only. Eskiz issues long-lived tokens; this never persists one. */
  private token: string | null = null;

  constructor(config: ConfigService<AppEnv, true>) {
    super();

    this.baseUrl = config.get('ESKIZ_BASE_URL', { infer: true });
    this.email = config.get('ESKIZ_EMAIL', { infer: true });
    this.password = config.get('ESKIZ_PASSWORD', { infer: true });
    this.from = config.get('ESKIZ_FROM', { infer: true });
    this.timeoutMs = config.get('ESKIZ_TIMEOUT_MS', { infer: true });
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    try {
      const first = await this.post(message, await this.authorize());

      // 401 means the token expired, not that the credentials are wrong - Eskiz answers
      // 400 for those. Re-login once and send again.
      if (first.status !== 401) {
        return await this.toResult(first, message);
      }

      this.token = null;

      return await this.toResult(
        await this.post(message, await this.authorize()),
        message,
      );
    } catch (error: unknown) {
      // A network failure, a timeout, or a login that never succeeded. The caller turns
      // this into a localized "we could not send the code" - never a silent success.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMS to ${maskPhone(message.phone)} failed: ${detail}`);

      return { status: 'failed', error: 'sms_transport_failed' };
    }
  }

  private post(message: SmsMessage, token: string): Promise<Response> {
    // `mobile_phone` without the leading `+`, which is what the provider's own clients
    // send. `normalizePhone` guarantees the `+998…` form, so this is a strip rather than
    // a parse.
    const body = new URLSearchParams({
      mobile_phone: message.phone.replace(/^\+/, ''),
      message: message.text,
      from: this.from,
    });

    return fetch(`${this.baseUrl}/api/message/sms/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async toResult(
    response: Response,
    message: SmsMessage,
  ): Promise<SmsResult> {
    const text = await response.text();

    if (!response.ok) {
      // The provider's body can quote the message back, so it is logged but never
      // returned: the client gets a code, not a provider's prose.
      this.logger.error(
        `Eskiz refused a message to ${maskPhone(message.phone)}: ` +
          `${response.status} ${text.slice(0, 200)}`,
      );

      return {
        status: 'failed',
        // The one refusal worth distinguishing: on a fresh account only three exact
        // test strings are accepted, and the fix is a template approval rather than
        // anything in this codebase.
        error: text.includes('template')
          ? 'sms_template_not_approved'
          : `sms_rejected_${response.status}`,
      };
    }

    const parsed = safeParse(text);

    this.logger.log(
      `SMS sent to ${maskPhone(message.phone)} (${message.locale})` +
        (parsed?.id ? ` as ${String(parsed.id)}` : ''),
    );

    return {
      status: 'sent',
      ...(parsed?.id ? { providerMessageId: String(parsed.id) } : {}),
    };
  }

  /**
   * A bearer token, cached in memory.
   *
   * There is no expiry in the login response to key a cache on, so the token is held
   * until a 401 invalidates it - which is why `send` clears it rather than trying to
   * predict expiry. `PATCH /api/auth/refresh` exists and is deliberately unused: it is
   * one more failure mode for a token this happily re-obtains.
   */
  private async authorize(): Promise<string> {
    if (this.token) {
      return this.token;
    }

    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: this.email, password: this.password }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      // Never log the body of a failed login: it is a credential exchange.
      throw new Error(`Eskiz login failed with ${response.status}`);
    }

    const parsed = safeParse(await response.text());
    const token = (parsed?.data as { token?: string } | undefined)?.token;

    if (!token) {
      throw new Error('Eskiz login returned no token');
    }

    this.token = token;

    return token;
  }
}

/** Never throws: a provider that answers HTML on an error must not crash the request. */
function safeParse(
  text: string,
): (EskizSendResponse & { data?: unknown }) | null {
  try {
    return JSON.parse(text) as EskizSendResponse & { data?: unknown };
  } catch {
    return null;
  }
}
