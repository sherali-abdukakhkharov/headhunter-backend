import { type Kysely, sql } from 'kysely';

/**
 * Fixed-window rate-limit counters (§12.5).
 *
 * Design notes that are not obvious from the DDL:
 *
 * - **Postgres rather than in-memory.** An in-process counter is per instance, so
 *   the effective limit multiplies by the number of app replicas - which is the
 *   opposite of a limit. OTP and auth volumes are low enough that one upsert per
 *   attempt is not worth avoiding. If a later high-volume bucket (search) proves
 *   this too expensive, that bucket gets its own store; the low-volume ones stay
 *   correct here.
 * - **One row per (bucket, subject), not per window.** The window start is a
 *   column that resets on rollover, so the table is bounded by the number of
 *   distinct phones and IPs seen rather than growing forever with every window.
 * - **A phone subject is stored hashed**, under the same pepper as OTP codes.
 *   This table would otherwise become a second, unencrypted register of every
 *   phone number that has ever touched the API (§12.1).
 * - **Fixed window, not sliding.** A fixed window permits a burst across a
 *   boundary (up to 2× the limit in the worst case); it also costs exactly one
 *   statement with no history table. Accepted deliberately - these buckets exist
 *   to stop abuse and SMS cost, not to shape traffic precisely.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('rate_limit_counters')
    // Which limit this counts: 'otp', 'auth', and the remaining §12.5 buckets
    // as they arrive. Text rather than an enum so adding a bucket is code, not
    // a migration - the value never reaches a client and is never filtered on.
    .addColumn('bucket', 'text', (col) => col.notNull())
    // The thing being limited: an IP literal, or a hashed phone number.
    .addColumn('subject', 'text', (col) => col.notNull())
    .addColumn('window_start', 'timestamptz', (col) => col.notNull())
    .addColumn('hits', 'integer', (col) => col.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('rate_limit_counters_pkey', ['bucket', 'subject'])
    .execute();

  // Supports pruning subjects that have gone quiet. Nothing prunes yet; the
  // maintenance job is an M11 ops task, and until then a stale row is one row
  // per phone or IP, which is not a problem worth a scheduler.
  await db.schema
    .createIndex('rate_limit_counters_window_start_idx')
    .on('rate_limit_counters')
    .column('window_start')
    .execute();

  await db
    .updateTable('app_meta')
    .set({ value: '3', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rate_limit_counters').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '2', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
