import { type Kysely, sql } from 'kysely';

/**
 * Telegram becomes the login credential (client direction, 2026-08-05).
 *
 * §4.1 specifies phone + OTP. The client has chosen Telegram login for the MVP
 * instead, so the identity model changes shape:
 *
 * - **`telegram_user_id` is the credential.** It is the `sub`/`id` claim of a
 *   Telegram-signed OpenID Connect id_token, stable per user and per bot-family,
 *   and it is the only field guaranteed to be present after a login.
 * - **`phone` becomes nullable.** It now arrives from the `phone` scope's
 *   `phone_number` claim, which the user may decline to grant. It stays unique, and
 *   Postgres permits many NULLs in a unique index, so accounts without one coexist.
 * - **A `CHECK` requires at least one credential.** A row with neither is
 *   unreachable by any login path - nobody could ever sign into it again - so the
 *   database refuses to hold one.
 *
 * `phone` keeps its own uniqueness, which is what makes account linking safe: a
 * Telegram login carrying a *verified* phone that already exists attaches to that
 * account rather than creating a second one. Linking on an unverified phone would
 * be an account-takeover primitive, so the service checks
 * `phone_number_verified` before it ever matches on phone.
 *
 * The OTP tables are deliberately left in place. The flow is switched off by
 * `OTP_LOGIN_ENABLED`, not deleted: §4.1 still specifies it, and dropping the
 * schema would make coming back a migration instead of a config change.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    // Telegram user ids are well beyond 32 bits.
    .addColumn('telegram_user_id', 'bigint', (col) => col.unique())
    .execute();

  await db.schema
    .alterTable('users')
    // `@username`, without the `@`. Optional on Telegram, and changeable by the
    // user, so it is support and admin-search material only - never an identity.
    .addColumn('telegram_username', 'text')
    .execute();

  await sql`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`.execute(db);

  await sql`
    ALTER TABLE users ADD CONSTRAINT users_has_a_credential
      CHECK (phone IS NOT NULL OR telegram_user_id IS NOT NULL)
  `.execute(db);

  // Every Telegram login starts with this lookup.
  await sql`
    CREATE INDEX users_telegram_user_id_idx
      ON users (telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '6', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX users_telegram_user_id_idx`.execute(db);
  await sql`ALTER TABLE users DROP CONSTRAINT users_has_a_credential`.execute(
    db,
  );

  // Rows created by a Telegram login without a phone cannot satisfy the restored
  // NOT NULL. Refusing to guess: rolling back is a decision about real accounts,
  // so it fails loudly rather than inventing placeholder phone numbers.
  const orphans = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM users WHERE phone IS NULL`.execute(db);

  if (Number(orphans.rows[0].count) > 0) {
    throw new Error(
      `Cannot roll back: ${orphans.rows[0].count} user(s) have no phone number. ` +
        'They were created by Telegram login and restoring NOT NULL would ' +
        'require inventing a phone number for each. Decide what should happen ' +
        'to those accounts first.',
    );
  }

  await sql`ALTER TABLE users ALTER COLUMN phone SET NOT NULL`.execute(db);

  await db.schema.alterTable('users').dropColumn('telegram_username').execute();

  await db.schema.alterTable('users').dropColumn('telegram_user_id').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '5', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
