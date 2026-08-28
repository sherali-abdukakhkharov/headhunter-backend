import { type Kysely, sql } from 'kysely';

import { DEMO_PHONE_PREFIX } from '@infra/phone/demo-phone';

import type { DB } from '../database.types';

/**
 * Removes every row `pnpm seed:demo` wrote, and the ability to log in with a fixed
 * code along with it.
 *
 * **The reserved prefix is the whole mechanism.** No marker column and no manifest of
 * ids written at seed time: `phone LIKE '+99801%'` finds exactly the demo accounts and
 * can match nothing else, because the numbering plan cannot allocate a number that
 * begins that way. `load-seed.ts` removes its own rows the same way, one digit over.
 *
 * ## Two accounts cannot be deleted, and that is correct
 *
 * `DELETE FROM users` is not the whole teardown, and the reason is not an oversight in
 * the schema — it is two rules this product deliberately enforces in the database:
 *
 * - **`admin_audit_log` is append-only**, with a trigger that refuses DELETE, UPDATE
 *   and TRUNCATE (§10.4). An audit row that forgot who acted is not an audit row, so
 *   `actor_user_id` is also `ON DELETE RESTRICT`.
 * - **`wallet_transactions` is append-only** for the same reason, and
 *   `employer_wallets.user_id` restricts, so that a deleted-and-re-registered account
 *   cannot mint a second registration bonus (2026-08-10).
 *
 * Every demo employer has a wallet the moment it takes the employer role, and the demo
 * administrator has audit rows the moment a tester approves anything. So a teardown
 * that only deleted would fail for four accounts out of ten, and one that disabled the
 * triggers would be defeating the exact protections it is running inside.
 *
 * **So it does what this product already does with an account that has acted**:
 * `RetentionService` purges what it can and *anonymises* what it cannot — the phone,
 * the name and the login history go; the row and its id stay to hold the audit trail
 * up. This is modelled on `purgeAccount` and follows the same statement order, which
 * that method's comment describes as "the whole trick": three tables hold `RESTRICT`
 * references to `stored_files`, so they have to be released before the files, and the
 * files before the account that cascades to them.
 *
 * The security-relevant half is unaffected either way. An anonymised account has no
 * phone number, so it is outside the reserved range, matches nothing here, and cannot
 * be signed into — and its `demo_accounts` row is gone regardless, which is what
 * actually removes the fixed code.
 *
 * ## What it cannot remove: the uploaded bytes
 *
 * The `stored_files` rows go, but the files themselves are messages in the Telegram
 * storage chat, and a bot may only delete its own messages for 48 hours
 * (ARCHITECTURE.md §9). Fixture documents older than that stay in the chat. They are
 * generated CVs for invented people, so this is untidy rather than a disclosure — but
 * it is the reason to re-seed rather than to seed repeatedly.
 */
export interface TeardownReport {
  deleted: number;
  anonymized: number;
  demoLogins: number;
  files: number;
  complaints: number;
  otpCodes: number;
}

const LIKE = `${DEMO_PHONE_PREFIX}%`;

export async function removeDemoWorld(db: Kysely<DB>): Promise<TeardownReport> {
  return db.transaction().execute(async (trx) => {
    const demoUsers = trx
      .selectFrom('users')
      .select('id')
      .where('phone', 'like', LIKE);

    // Complaints first, and before the accounts go: `complaints.target_id` carries no
    // foreign key — it names a vacancy, a profile, a message or a user by convention —
    // so a complaint about a demo vacancy would survive every cascade and then sit in
    // the administrator's queue forever, pointing at nothing.
    const complaints = await trx
      .deleteFrom('complaints')
      .where((eb) =>
        eb.or([
          eb('reporter_user_id', 'in', demoUsers),
          eb('target_id', 'in', demoUsers),
          eb(
            'target_id',
            'in',
            trx
              .selectFrom('vacancies')
              .select('id')
              .where('employer_user_id', 'in', demoUsers),
          ),
        ]),
      )
      .executeTakeFirst();

    // A purchase record, and `candidate_user_id` restricts because it is the employer's
    // and not the candidate's to erase. Not append-only, so it can go — both sides of
    // every demo unlock are fixtures.
    await trx
      .deleteFrom('candidate_unlocks')
      .where((eb) =>
        eb.or([
          eb('candidate_user_id', 'in', demoUsers),
          eb('employer_user_id', 'in', demoUsers),
        ]),
      )
      .execute();

    // The four statements below are `purgeAccount`'s order, for its reasons: release
    // the three RESTRICT references to `stored_files`, then the files.
    await trx
      .updateTable('companies')
      .set({ logo_file_id: null })
      .where('employer_user_id', 'in', demoUsers)
      .execute();

    await trx
      .deleteFrom('verification_submissions')
      .where('employer_user_id', 'in', demoUsers)
      .execute();

    await trx
      .deleteFrom('messages')
      .where('sender_user_id', 'in', demoUsers)
      .execute();

    const files = await trx
      .deleteFrom('stored_files')
      .where('owner_user_id', 'in', demoUsers)
      .executeTakeFirst();

    // Which accounts hold something that has to outlive them. Asked as one query
    // rather than per account: it decides delete-or-anonymise, and getting it wrong in
    // the optimistic direction aborts the whole transaction on a foreign key.
    const accounts = await trx
      .selectFrom('users')
      .select((eb) => [
        'users.id',
        eb
          .selectFrom('admin_audit_log as a')
          .select((inner) => inner.fn.countAll<string>().as('count'))
          .whereRef('a.actor_user_id', '=', 'users.id')
          .as('auditRows'),
        // The wallet row itself, not its transactions: `employer_wallets.user_id`
        // restricts, so a wallet with no ledger entries at all still refuses the
        // delete — reachable whenever the registration bonus is configured to zero.
        eb
          .selectFrom('employer_wallets as w')
          .select((inner) => inner.fn.countAll<string>().as('count'))
          .whereRef('w.user_id', '=', 'users.id')
          .as('wallets'),
      ])
      .where('phone', 'like', LIKE)
      .execute();

    const anonymize = accounts
      .filter((a) => Number(a.auditRows) > 0 || Number(a.wallets) > 0)
      .map((a) => a.id);
    const remove = accounts
      .filter((a) => !anonymize.includes(a.id))
      .map((a) => a.id);

    if (remove.length > 0) {
      // Everything else follows: profiles, employers, vacancies, applications,
      // conversations, sessions, notifications and every history table cascade.
      await trx.deleteFrom('users').where('id', 'in', remove).execute();
    }

    if (anonymize.length > 0) {
      // Their own data still goes, and the roles with it: an account nobody can sign
      // into must not remain a live administrator or a live employer. Deleting the
      // `employers` row takes its vacancies, applications and conversations with it.
      for (const table of [
        'candidate_profiles',
        'employers',
        'sessions',
        'user_roles',
        'device_tokens',
      ] as const) {
        await trx.deleteFrom(table).where('user_id', 'in', anonymize).execute();
      }

      // `users_purged_has_no_credential` and `users_purged_has_no_name` refuse this
      // write if it leaves either behind, which is what makes "erased but still
      // reachable" unrepresentable rather than merely unwritten.
      await trx
        .updateTable('users')
        .set({
          phone: null,
          telegram_user_id: null,
          telegram_username: null,
          full_name: null,
          last_login_at: null,
          purged_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', 'in', anonymize)
        .execute();
    }

    // Keyed by phone rather than by user, so no cascade reaches them.
    const otpCodes = await trx
      .deleteFrom('otp_codes')
      .where('phone', 'like', LIKE)
      .executeTakeFirst();

    await trx
      .deleteFrom('rate_limit_counters')
      .where('subject', 'like', LIKE)
      .execute();

    // Last, and the one that matters most: with these gone no fixed code resolves, and
    // `OtpService` refuses the reserved range outright. The capability is the data.
    const demoLogins = await trx
      .deleteFrom('demo_accounts')
      .where('phone', 'like', LIKE)
      .executeTakeFirst();

    return {
      deleted: remove.length,
      anonymized: anonymize.length,
      demoLogins: Number(demoLogins.numDeletedRows),
      files: Number(files.numDeletedRows),
      complaints: Number(complaints.numDeletedRows),
      otpCodes: Number(otpCodes.numDeletedRows),
    };
  });
}

/**
 * A safety check the caller runs before seeding: is anything already there?
 *
 * Re-seeding on top of an existing world does not merge, it collides — the phone
 * numbers are unique, so `createAccount` would sign the existing account in rather than
 * create it, and every write after that would land on top of the old one.
 */
export async function demoUserCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select(sql<string>`count(*)`.as('count'))
    .where('phone', 'like', LIKE)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}
