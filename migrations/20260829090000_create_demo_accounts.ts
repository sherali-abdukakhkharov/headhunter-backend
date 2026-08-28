import { type Kysely, sql } from 'kysely';

/**
 * Fixed login codes, for the handful of accounts a tester signs in as.
 *
 * **Why this is not `OTP_STATIC_CODE`.** That variable fixes the code for *every*
 * account on the instance — its own comment calls it a master key — and the env
 * schema refuses it in production for that reason. But production is exactly where
 * the QA pass runs: the testers install the release APK, which talks to
 * `hh.qitmir.uz`. So a switch that cannot be on in production cannot answer "let a
 * tester log in without an SMS", and turning it on anyway would put a master key on
 * the instance holding real accounts.
 *
 * This is the narrow version of the same idea. A row here fixes the code for **one
 * phone number**, and the capability exists only while the row does: `pnpm
 * seed:demo:clean` deletes them and the instance is back to random codes with no
 * configuration change and nothing to remember to switch off.
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **The CHECK is the whole security argument.** A number can only be given a fixed
 *   code if it starts with `+99801`, and no such number can exist: after the country
 *   code, Uzbekistan's numbering plan has no destination code beginning with `0` —
 *   `0` is the domestic trunk prefix. The number cannot be dialled, cannot be
 *   allocated to a subscriber, and therefore cannot be signed up for by a person who
 *   would then find a stranger already holding their account. The load seeder relies
 *   on the same guarantee one digit over, at `+99800`.
 *
 *   Written as a constraint rather than a check in the seeder because the seeder is
 *   not the only thing that could ever insert here, and a rule that lives in the
 *   database is one that a future route, a migration or a hand-typed `INSERT` cannot
 *   get wrong.
 *
 * - **The code is stored in plain text, deliberately.** It is published in
 *   `docs/TEST_ACCOUNTS.md` — a shared credential is the point. Hashing it would
 *   protect nothing and would remove the one thing this table is for, which is
 *   answering "what is the code for this number" from SQL. The *account's* real
 *   secret is unchanged: `otp_codes` still stores a peppered hash, because this only
 *   decides which code gets issued, never how it is checked.
 *
 * - **No foreign key to `users`.** `POST /auth/otp/send` runs before the account
 *   exists — registration and login are the same call (§4.1) — so the code has to be
 *   resolvable from the phone number alone, exactly as `otp_codes` is.
 *
 * - **`label` exists so the log line is legible.** Every demo login writes one, and
 *   "issued the fixed code for Aziza Karimova (candidate)" is what makes an
 *   unexpected one visible; a bare masked number would not be.
 */
export async function up(db: Kysely<never>): Promise<void> {
  await db.schema
    .createTable('demo_accounts')
    .addColumn('phone', 'text', (col) => col.primaryKey())
    .addColumn('code', 'text', (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'demo_accounts_phone_is_reserved',
      sql`phone LIKE '+99801%'`,
    )
    // A code that is not digits, or not the length the client renders, would fail
    // at the code screen with nothing to explain it.
    .addCheckConstraint(
      'demo_accounts_code_is_digits',
      sql`code ~ '^[0-9]{4,8}$'`,
    )
    .execute();
}

export async function down(db: Kysely<never>): Promise<void> {
  await db.schema.dropTable('demo_accounts').execute();
}
