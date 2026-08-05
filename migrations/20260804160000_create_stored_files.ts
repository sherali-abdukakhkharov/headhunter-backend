import { type Kysely, sql } from 'kysely';

/**
 * File metadata for the Telegram-backed store (§5.4, §9 of ARCHITECTURE.md).
 *
 * Bytes live in Telegram; this table is the record of what exists, who owns it,
 * and what it is for. That split is what the columns are shaped around:
 *
 * - **`telegram_file_id` is the download handle**, and it is per-bot. Changing the
 *   bot token invalidates every one of them, which is why the token is treated as
 *   part of the data layer rather than an ordinary secret to rotate.
 * - **`telegram_file_unique_id` is the identity.** Telegram documents it as stable
 *   over time and across bots but *not* usable to download. Stored so a re-upload
 *   of identical bytes is recognisable, and so a future bot migration has
 *   something to reconcile against.
 * - **`telegram_message_id`** is kept because the file only exists as long as that
 *   message does. Without it there is no way to find the message again to delete
 *   it, and no way to prove where a file came from.
 * - **No file path or URL column.** Telegram's download URL embeds the bot token
 *   and expires within about an hour; persisting one would be both a secret in the
 *   database and a stale value. It is fetched per download instead.
 * - **`purpose_id` is a dictionary item**, not an enum. The `file_purpose`
 *   dictionary drives the client's attachment block (API_CONTRACTS.md §4.5), so a
 *   new evidence type is a dictionary row rather than a migration.
 * - **Soft delete.** `deleted_at` rather than a DELETE: a CV referenced by a
 *   submitted application must stay resolvable for the employer's history, and
 *   BR-14's retention period is still an open question, so nothing is purged yet.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('stored_files')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    // The uploader. Ownership is checked on every read (§11.1, BR-09) - a file is
    // never public, so there is always someone whose permission is being tested.
    .addColumn('owner_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('purpose_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('telegram_file_id', 'text', (col) => col.notNull())
    .addColumn('telegram_file_unique_id', 'text', (col) => col.notNull())
    .addColumn('telegram_message_id', 'bigint', (col) => col.notNull())
    // As supplied by the uploader, sanitized before storage. Shown to the user and
    // used for the download filename, so it is never trusted as a path.
    .addColumn('file_name', 'text', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    // SHA-256 of the bytes we sent. Lets a re-upload be detected and gives an
    // integrity check on download that does not depend on Telegram.
    .addColumn('sha256', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    // A zero-byte upload is always a client bug; the size is also the guard
    // against a stored row claiming a size the transport never enforced.
    .addCheckConstraint('stored_files_size_positive', sql`size_bytes > 0`)
    .execute();

  // "My files of this purpose", which is every read the client makes.
  await sql`
    CREATE INDEX stored_files_owner_purpose_idx
      ON stored_files (owner_user_id, purpose_id)
      WHERE deleted_at IS NULL
  `.execute(db);

  // Recognises a re-upload of identical bytes by the same owner.
  await sql`
    CREATE INDEX stored_files_owner_unique_id_idx
      ON stored_files (owner_user_id, telegram_file_unique_id)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '5', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('stored_files').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '4', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
