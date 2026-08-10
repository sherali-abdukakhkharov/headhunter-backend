import { type Kysely, sql } from 'kysely';

/**
 * M11 schema: what is left of an account after BR-14's purge.
 *
 * The purge has two outcomes, and this migration exists because the second one had nowhere
 * to land. A user with no audit rows is deleted outright and sixteen cascades take their
 * data with them. A user who has **acted as an administrator** cannot be deleted at all:
 * `admin_audit_log.actor_user_id` is `ON DELETE RESTRICT`, deliberately, because an audit
 * row that forgot who acted is not an audit row (§10.4).
 *
 * That collision was left open from M10 on purpose. It is resolved here by erasing the
 * *person* and keeping the *actor*: phone, Telegram identity and last-login go, the row and
 * its id stay, and every past decision still resolves to a distinct administrator without
 * naming one.
 *
 * **`purged_at` is the state, not just a receipt.** The obvious alternative was a new
 * `account_status = 'deleted'`, and it was tried and abandoned: Postgres refuses to use a
 * new enum value in the transaction that added it, Kysely runs every pending migration in
 * one transaction, and there is no ordering of two files that escapes that. A timestamp
 * needs no enum, survives `migrate:latest` on a fresh database, and answers more than a
 * label would - *when* the erasure happened is the part an auditor asks about. The account
 * keeps `status = 'deletion_requested'`, which every guard already refuses.
 *
 * Both checks are the point of the migration. Without them, "purged" would be a claim made
 * by the service that wrote the row; with them it is a property of the table:
 *
 * - `users_has_a_credential` used to require a phone or a Telegram id, which is exactly
 *   what a purged account must not have. It now exempts a purged row - and still holds for
 *   every other row, so a live account with no way to sign in remains impossible.
 * - `users_purged_has_no_credential` is the other direction: a row with `purged_at` set
 *   cannot be holding a phone number. A purge that "succeeded" while leaving the number
 *   behind is the failure this makes unrepresentable.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('purged_at', 'timestamptz')
    .execute();

  // Dropped and rebuilt rather than added alongside: two overlapping checks on the same
  // columns would leave the next reader guessing which is authoritative.
  await sql`ALTER TABLE users DROP CONSTRAINT users_has_a_credential`.execute(
    db,
  );

  await sql`
    ALTER TABLE users ADD CONSTRAINT users_has_a_credential CHECK (
      purged_at IS NOT NULL
      OR phone IS NOT NULL
      OR telegram_user_id IS NOT NULL
    )
  `.execute(db);

  await sql`
    ALTER TABLE users ADD CONSTRAINT users_purged_has_no_credential CHECK (
      purged_at IS NULL
      OR (phone IS NULL AND telegram_user_id IS NULL)
    )
  `.execute(db);

  // The purge's own query: deletion requests whose grace period has run out. Partial, so
  // it stays small however many requests have already been dealt with, and it does not
  // index the rows a cancelled request left behind.
  await sql`
    CREATE INDEX deletion_requests_pending_purge_idx
      ON deletion_requests (requested_at)
      WHERE cancelled_at IS NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '18', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX deletion_requests_pending_purge_idx`.execute(db);
  await sql`ALTER TABLE users DROP CONSTRAINT users_purged_has_no_credential`.execute(
    db,
  );
  await sql`ALTER TABLE users DROP CONSTRAINT users_has_a_credential`.execute(
    db,
  );

  // Rolling back with a purged row present would fail this check, and should: the row has
  // no credential to restore, so there is nothing correct for a down migration to do with
  // it. Purge, then roll back, is not a supported order.
  await sql`
    ALTER TABLE users ADD CONSTRAINT users_has_a_credential CHECK (
      phone IS NOT NULL OR telegram_user_id IS NOT NULL
    )
  `.execute(db);

  await db.schema.alterTable('users').dropColumn('purged_at').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '17', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
