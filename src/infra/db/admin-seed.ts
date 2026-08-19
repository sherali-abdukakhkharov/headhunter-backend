import type { Kysely } from 'kysely';

import { normalizePhone } from '@infra/phone/phone';

import type { DB } from './database.types';

export interface AdminSeedReport {
  usersCreated: number;
  rolesGranted: number;
  alreadyAdmin: number;
}

/**
 * Grants the `admin` role to the phone numbers this deployment is configured with (§10).
 *
 * **Why this exists at all.** §10 is a role inside the mobile app and there is deliberately
 * **no route that grants it** - a product where administrators can create administrators over
 * the API has no floor. So the first one has to come from outside the API, and the seeder is
 * the place: it already runs on every deploy, it is idempotent, and it is the one command a
 * release job runs against the database.
 *
 * Without it an instance is not merely missing a feature, it is **stuck**: both MVP flags are
 * on since M10, so every employer who registers parks in `under_review` and no vacancy can be
 * moderated. That is the state the deployed instance has been in.
 *
 * **The numbers are configuration, not a literal in this file.** `SEED_ADMIN_PHONES` carries
 * them, for two reasons that are worth keeping:
 *
 * - A phone number is personal data, and a committed one would put a named individual in git
 *   history for every clone of this repository.
 * - More importantly, a hardcoded administrator is granted in **every** environment the code
 *   reaches - including any instance where `OTP_STATIC_CODE` is set, where knowing the number
 *   would be the whole of the authentication. Per-deployment configuration means a development
 *   instance and production do not share an administrator by default.
 *
 * It reads `process.env` through its caller rather than `ConfigService`, like the database
 * credentials in `seed.ts` do: this runs standalone under `tsx`, with no Nest application to
 * validate anything.
 *
 * **The account is created if it does not exist yet.** Logging in is still phone + OTP, so
 * this grants an entitlement and never a credential - there is no password here to leak, and
 * the person still has to prove they hold the SIM.
 */
export async function seedAdministrators(
  db: Kysely<DB>,
  rawPhones: string[],
): Promise<AdminSeedReport> {
  const report: AdminSeedReport = {
    usersCreated: 0,
    rolesGranted: 0,
    alreadyAdmin: 0,
  };

  for (const raw of rawPhones) {
    // The same normalization the login path applies, so a number written here with spaces or
    // without its `+` reaches the same row `POST /auth/otp/send` will look up. Getting this
    // wrong would create a second, unreachable account rather than failing loudly.
    const phone = normalizePhone(raw);

    const existing = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst();

    const userId =
      existing?.id ??
      (
        await db
          .insertInto('users')
          .values({ phone })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    if (!existing) {
      report.usersCreated += 1;
    }

    // `(user_id, role)` is the primary key of `user_roles`, so re-running is a no-op by
    // constraint rather than by a check - and `returning` is how we tell which happened.
    const granted = await db
      .insertInto('user_roles')
      .values({ user_id: userId, role: 'admin' })
      .onConflict((oc) => oc.doNothing())
      .returning('user_id')
      .executeTakeFirst();

    if (granted) {
      report.rolesGranted += 1;
    } else {
      report.alreadyAdmin += 1;
    }
  }

  return report;
}

/**
 * The configured administrator phone numbers, comma-separated.
 *
 * Empty is a supported state and the default: an instance that has not been told who
 * administers it grants nothing, which is safer than guessing.
 */
export function configuredAdminPhones(
  value: string | undefined = process.env.SEED_ADMIN_PHONES,
): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
