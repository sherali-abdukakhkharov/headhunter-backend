import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';
import { isDemoPhone } from '@infra/phone/demo-phone';
import { maskPhone } from '@infra/phone/phone';

/** A seeded tester account's fixed code, and who it belongs to. */
export interface DemoAccount {
  code: string;
  label: string;
}

/**
 * Resolves the fixed login code of a seeded tester account (`docs/TEST_ACCOUNTS.md`).
 *
 * The whole feature is one question — *does this phone number have a fixed code?* —
 * and two gates stand in front of it:
 *
 * 1. **The prefix**, checked first and in memory. Every login by a real user answers
 *    "no" here and never reaches the database, so this costs one string comparison on
 *    the hot path and cannot behave differently for a real account by any route.
 * 2. **`DEMO_ACCOUNTS_ENABLED`**, so the capability can be switched off for a live
 *    demo without deleting the fixtures, and is off in a deployment that has not
 *    deliberately asked for it.
 *
 * Both must pass, and the row must exist. That last part is why this is safe to leave
 * in the code permanently: with no rows there is nothing to resolve, so
 * `pnpm seed:demo:clean` removes the capability along with the data and leaves no
 * configuration anybody has to remember to switch off.
 *
 * **This decides which code is issued, never whether a code is accepted.** `verify` is
 * untouched — the same peppered hash, the same TTL, the same attempt limit, the same
 * single `auth.otp_invalid` for "no code", "expired" and "wrong code". A demo account
 * signs in through the real login path, which is the reason exercising one tests
 * anything at all.
 */
@Injectable()
export class DemoAccountService {
  private readonly logger = new Logger(DemoAccountService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    // `?? false` rather than trusting the schema's default, exactly as OtpService
    // does with OTP_STATIC_CODE: the integration specs build a ConfigService from a
    // plain object that Joi never validated.
    this.enabled =
      config.get('DEMO_ACCOUNTS_ENABLED', { infer: true }) ?? false;
  }

  /**
   * Whether this number is one nothing can deliver an SMS to.
   *
   * Deliberately independent of the flag. Switching demo accounts off does not make
   * a reserved number reachable — it is unallocatable by the numbering plan — so the
   * caller must still refuse rather than hand it to the SMS provider.
   */
  isReserved(phone: string): boolean {
    return isDemoPhone(phone);
  }

  /**
   * The fixed code for this number, or `null` for every number that is not a seeded
   * demo account.
   */
  async find(phone: string): Promise<DemoAccount | null> {
    if (!this.enabled || !isDemoPhone(phone)) {
      return null;
    }

    const row = await this.db
      .selectFrom('demo_accounts')
      .select(['code', 'label'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    if (!row) {
      // A reserved number with no row is a rollback leftover, a typo in the tester
      // document, or the flag being off in the process that seeded. Worth a line: the
      // caller is about to refuse, and this says which of the three it was.
      this.logger.warn(
        `No demo account for reserved number ${maskPhone(phone)}. ` +
          `Re-run "pnpm seed:demo" or check docs/TEST_ACCOUNTS.md.`,
      );
    }

    return row ?? null;
  }
}
