import type { Kysely } from 'kysely';

import { normalizePhone } from '@infra/phone/phone';

import type { DB } from './database.types';

export interface AdminSeedReport {
  usersCreated: number;
  rolesGranted: number;
  alreadyAdmin: number;
  namesWritten: number;
}

/** One configured administrator: a phone number, and optionally who holds it. */
export interface AdminSeedEntry {
  phone: string;
  fullName: string | null;
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
 *
 * **The name is written to `users.full_name`, and configuration is its only writer.** An
 * administrator holds no `candidate_profiles` row and no `employers` row, so §10.2's user list
 * had nothing to render for one and its name filter could not find one. Re-running with a
 * changed name updates it; re-running with none leaves whatever is there, so dropping the name
 * from the variable does not erase it.
 */
export async function seedAdministrators(
  db: Kysely<DB>,
  entries: AdminSeedEntry[],
): Promise<AdminSeedReport> {
  const report: AdminSeedReport = {
    usersCreated: 0,
    rolesGranted: 0,
    alreadyAdmin: 0,
    namesWritten: 0,
  };

  for (const entry of entries) {
    // The same normalization the login path applies, so a number written here with spaces or
    // without its `+` reaches the same row `POST /auth/otp/send` will look up. Getting this
    // wrong would create a second, unreachable account rather than failing loudly.
    const phone = normalizePhone(entry.phone);

    const existing = await db
      .selectFrom('users')
      .select(['id', 'full_name'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    const userId =
      existing?.id ??
      (
        await db
          .insertInto('users')
          .values({ phone, full_name: entry.fullName })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    if (existing) {
      // Only when it would change something: an unconditional update would touch
      // `updated_at` on every deploy and make the seeder look like it did work.
      if (entry.fullName !== null && existing.full_name !== entry.fullName) {
        await db
          .updateTable('users')
          .set({ full_name: entry.fullName })
          .where('id', '=', userId)
          .execute();

        report.namesWritten += 1;
      }
    } else {
      report.usersCreated += 1;

      if (entry.fullName !== null) {
        report.namesWritten += 1;
      }
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
 * The configured administrators: `phone[:full name]`, comma-separated.
 *
 * `+998901234567:Karimov Anvar Rustam o'g'li,+998901234568` is two administrators, one of
 * them named. The two separators cannot collide with their fields - a phone number in
 * international form holds no colon, and no name holds a comma - so neither needs quoting.
 * The name is everything after the *first* colon, which is what makes a name containing one
 * survive.
 *
 * Empty is a supported state and the default: an instance that has not been told who
 * administers it grants nothing, which is safer than guessing.
 */
export function configuredAdministrators(
  value: string | undefined = process.env.SEED_ADMIN_PHONES,
): AdminSeedEntry[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(':');

      if (separator === -1) {
        return { phone: entry, fullName: null };
      }

      const fullName = entry.slice(separator + 1).trim();

      return {
        phone: entry.slice(0, separator).trim(),
        // A trailing colon with nothing after it is "no name", not an empty one: the
        // column is nullable precisely so an unnamed administrator stays unnamed.
        fullName: fullName.length > 0 ? fullName : null,
      };
    });
}
