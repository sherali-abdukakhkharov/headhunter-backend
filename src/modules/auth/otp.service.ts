import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  TooManyRequestsError,
  UnauthorizedError,
  UpstreamError,
} from '@infra/api/exceptions/localized.exception';
import { generateOtpCode, hashSecret, verifySecret } from '@infra/crypto/hash';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { LocaleCode, OtpPurpose } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { translate } from '@infra/i18n/translate';
import { maskPhone } from '@infra/phone/phone';

import { SmsSender } from './sms/sms-sender';

export interface OtpSendResult {
  expiresAt: Date;
  resendAvailableAt: Date;

  /**
   * The rules of the challenge that was just created, so the client does not
   * have to guess them.
   *
   * Both are configuration (§4.2) and neither is a secret. Publishing them is
   * what lets the code field size itself and the screen count attempts down;
   * before it, the client hard-coded six digits and could say nothing about
   * the limit until the server refused.
   *
   * **`maxAttempts` is the limit, never the number remaining.** See the DTO for
   * why: a remaining count on a failed verify would tell an attacker that a
   * code is pending for that phone, which is precisely what the one shared
   * `auth.otp_invalid` message exists to hide.
   */
  codeLength: number;
  maxAttempts: number;

  /** Populated only when `OTP_ECHO_IN_RESPONSE` is on; never in production. */
  devCode?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  private readonly pepper: string;
  private readonly length: number;
  private readonly ttlSeconds: number;
  private readonly resendDelaySeconds: number;
  private readonly maxAttempts: number;
  private readonly echoInResponse: boolean;
  private readonly staticCode: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly sms: SmsSender,
    config: ConfigService<AppEnv, true>,
  ) {
    this.pepper = config.get('TOKEN_HASH_PEPPER', { infer: true });
    this.length = config.get('OTP_LENGTH', { infer: true });
    this.ttlSeconds = config.get('OTP_TTL_SECONDS', { infer: true });
    this.resendDelaySeconds = config.get('OTP_RESEND_DELAY_SECONDS', {
      infer: true,
    });
    this.maxAttempts = config.get('OTP_MAX_ATTEMPTS', { infer: true });
    this.echoInResponse = config.get('OTP_ECHO_IN_RESPONSE', { infer: true });
    // `?? ''` rather than trusting the schema's default: the integration tests
    // build a ConfigService from a plain object that Joi never saw.
    this.staticCode = config.get('OTP_STATIC_CODE', { infer: true }) ?? '';

    if (this.staticCode) {
      // A length mismatch is otherwise silent and baffling: the client renders
      // OTP_LENGTH boxes and the code that works does not fit in them. Fail at
      // boot, where the person who set the variable is still looking.
      if (this.staticCode.length !== this.length) {
        throw new Error(
          `OTP_STATIC_CODE is ${this.staticCode.length} digits but OTP_LENGTH ` +
            `is ${this.length}; they must match.`,
        );
      }

      // Loud, once, at startup. This is a master key for every account on the
      // instance, so its presence should be impossible to miss in a log.
      this.logger.warn(
        'OTP_STATIC_CODE is set: every login code is fixed. Development only.',
      );
    }
  }

  /**
   * Issues a code for a phone and purpose.
   *
   * Runs in a transaction that supersedes any live code first: the schema allows
   * only one unconsumed code per (phone, purpose), so a retrying client cannot
   * accumulate valid codes. Two concurrent sends serialize on the unique index
   * and the loser fails rather than both succeeding.
   */
  async send(
    phone: string,
    purpose: OtpPurpose,
    requestedIp: string | null,
    locale: LocaleCode = 'uz-Latn',
  ): Promise<OtpSendResult> {
    const issued = await this.issue(phone, purpose, requestedIp);

    await this.deliver(phone, purpose, locale, issued.code);

    return issued.result;
  }

  /**
   * Issues and stores the code, inside one transaction.
   *
   * Split from delivery on purpose. An HTTP call to the SMS provider inside this
   * transaction would hold the row lock for the provider's latency, and a provider
   * timeout would roll back the code it had already sent - the same trap MEMORY.md
   * records for OTP attempt counters, in the other direction.
   */
  private async issue(
    phone: string,
    purpose: OtpPurpose,
    requestedIp: string | null,
  ): Promise<{ result: OtpSendResult; code: string; id: string }> {
    return this.db.transaction().execute(async (trx) => {
      // The delay is evaluated entirely in the database. Comparing a Postgres
      // `created_at` against the app's `Date.now()` mixes two clocks: a few
      // milliseconds of container drift is enough to refuse a legitimate resend
      // (or, with the skew the other way, to allow one early).
      const recent = await trx
        .selectFrom('otp_codes')
        .select(
          sql<number>`ceil(extract(epoch FROM
            created_at + make_interval(secs => ${this.resendDelaySeconds}) - now()
          ))::int`.as('retry_after'),
        )
        .where('phone', '=', phone)
        .where('purpose', '=', purpose)
        .where(
          'created_at',
          '>',
          sql<Date>`now() - make_interval(secs => ${this.resendDelaySeconds})`,
        )
        .limit(1)
        .executeTakeFirst();

      if (recent) {
        throw new TooManyRequestsError(
          'auth.otp_resend_too_soon',
          Math.max(recent.retry_after, 1),
        );
      }

      // Supersede the live code so the partial unique index has room. Marking it
      // consumed also makes it unusable, which is the intent - the client only
      // ever has one valid code.
      await trx
        .updateTable('otp_codes')
        .set({ consumed_at: sql<Date>`now()` })
        .where('phone', '=', phone)
        .where('purpose', '=', purpose)
        .where('consumed_at', 'is', null)
        .execute();

      // The only place the backdoor exists. Everything downstream - the hash,
      // the row, the TTL, the attempt counter, `verify` - is identical either
      // way, so clearing OTP_STATIC_CODE once an SMS provider is connected
      // changes no behaviour that has been exercised.
      const code = this.staticCode || generateOtpCode(this.length);

      const inserted = await trx
        .insertInto('otp_codes')
        .values({
          phone,
          purpose,
          code_hash: hashSecret(code, this.pepper),
          // Expiry is database-relative for the same reason as the delay above.
          expires_at: sql<Date>`now() + make_interval(secs => ${this.ttlSeconds})`,
          requested_ip: requestedIp,
        })
        .returning(['id', 'created_at', 'expires_at'])
        .executeTakeFirstOrThrow();

      // The code is never logged (§12.1, §4.2) and the phone is truncated.
      this.logger.log(`OTP issued for ${maskPhone(phone)} (${purpose})`);

      return {
        result: {
          expiresAt: inserted.expires_at,
          resendAvailableAt: new Date(
            inserted.created_at.getTime() + this.resendDelaySeconds * 1000,
          ),
          // The challenge describes its own rules. Read from the same fields
          // that enforce them, so a configuration change reaches the client on
          // the next send rather than needing an app release.
          codeLength: this.length,
          maxAttempts: this.maxAttempts,
          ...(this.echoInResponse ? { devCode: code } : {}),
        },
        code,
        id: inserted.id,
      };
    });
  }

  /**
   * Hands the code to the SMS provider, after the commit.
   *
   * **A failed send removes the row it was for.** Two reasons, and the second is the one
   * that would have been found in production: a code nobody received should not be
   * consuming the one-live-code slot, and - because the resend delay is measured from
   * the most recent row whatever its state - leaving it would lock the user out of
   * retrying for a minute for a message that never arrived.
   *
   * Then it throws. "Sent" when nothing was sent is the worst available outcome for
   * somebody staring at a code-entry screen.
   *
   * The one exception is a deployment with no provider configured, where the logging
   * sender reports `failed` by design. There the code is still wanted: `OTP_STATIC_CODE`
   * and `OTP_ECHO_IN_RESPONSE` are how anybody logs in, and deleting the row would break
   * every development and test login.
   */
  private async deliver(
    phone: string,
    purpose: OtpPurpose,
    locale: LocaleCode,
    code: string,
  ): Promise<void> {
    const result = await this.sms.send({
      phone,
      text: translate('sms.otp_code', locale, { code }),
      locale,
    });

    if (result.status === 'sent' || result.error === 'sms_not_configured') {
      return;
    }

    await this.db
      .deleteFrom('otp_codes')
      .where('phone', '=', phone)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .execute();

    this.logger.error(
      `OTP delivery failed for ${maskPhone(phone)} (${purpose}): ${result.error ?? 'unknown'}`,
    );

    throw new UpstreamError('auth.otp_send_failed');
  }

  /**
   * Consumes a code.
   *
   * The row is locked for the duration so concurrent verify attempts cannot each
   * read `attempts` before the other increments it - otherwise the attempt limit
   * is trivially bypassed by sending N requests at once.
   *
   * The transaction **returns** an outcome rather than throwing it. Throwing from
   * inside `transaction().execute()` rolls the transaction back, which would undo
   * the very attempt increment and lockout the exception is reporting: every
   * wrong guess would reset the counter to zero and the limit would never bite.
   * The failure is reported after the commit.
   */
  async verify(
    phone: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<void> {
    const outcome = await this.db
      .transaction()
      .execute<VerifyOutcome>(async (trx) => {
        const row = await trx
          .selectFrom('otp_codes')
          .select(['id', 'code_hash', 'attempts'])
          .where('phone', '=', phone)
          .where('purpose', '=', purpose)
          .where('consumed_at', 'is', null)
          // Expiry is part of the predicate, evaluated by the database clock -
          // the row that wrote `expires_at` used `now()`, so the comparison must
          // too.
          .where('expires_at', '>', sql<Date>`now()`)
          .forUpdate()
          .executeTakeFirst();

        if (!row) {
          return 'invalid';
        }

        if (row.attempts >= this.maxAttempts) {
          // Consumed on lockout so the code cannot be attacked further; the
          // client must request a new one.
          await trx
            .updateTable('otp_codes')
            .set({ consumed_at: sql<Date>`now()` })
            .where('id', '=', row.id)
            .execute();

          return 'locked_out';
        }

        if (!verifySecret(code, row.code_hash, this.pepper)) {
          await trx
            .updateTable('otp_codes')
            .set({ attempts: row.attempts + 1 })
            .where('id', '=', row.id)
            .execute();

          return 'invalid';
        }

        await trx
          .updateTable('otp_codes')
          .set({ consumed_at: sql<Date>`now()` })
          .where('id', '=', row.id)
          .execute();

        return 'verified';
      });

    if (outcome === 'locked_out') {
      // No `Retry-After`: a locked-out code is not waiting for a clock, the
      // client has to request a new one.
      throw new TooManyRequestsError('auth.otp_too_many_attempts');
    }

    // One message for "no code", "expired" and "wrong code": distinguishing
    // them tells an attacker which phone numbers have a pending code.
    if (outcome === 'invalid') {
      throw new UnauthorizedError('auth.otp_invalid');
    }
  }
}

/**
 * Result of a verify transaction.
 *
 * Exists so the transaction can commit its attempt counter before the caller
 * turns the failure into an exception; see `OtpService.verify`.
 */
type VerifyOutcome = 'verified' | 'invalid' | 'locked_out';
