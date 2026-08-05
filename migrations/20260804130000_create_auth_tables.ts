import { type Kysely, sql } from 'kysely';

/**
 * M1 schema: identity, roles, OTP, sessions, status audit, deletion requests.
 *
 * Design notes that are not obvious from the DDL:
 *
 * - **Roles are rows, not a column** (§2.3). One account may hold several roles,
 *   so authorization asks "may this user, acting as this role, do this" - never
 *   "what role is this user".
 * - **`otp_codes.phone` is not a foreign key.** A registration OTP is issued
 *   before any user row exists, so the table keys on the phone number itself.
 * - **Sessions carry a `family_id`.** Refresh rotation replaces a row and points
 *   `replaced_by_session_id` at its successor; presenting a token whose row is
 *   already revoked is reuse, and the response is to revoke the whole family.
 *   Without the family column that revocation is a recursive walk.
 * - **`account_status_history` is append-only** (§10.2, BR-08). No update or
 *   delete path is ever added; M10 asserts that in a test.
 * - **`deletion_requests.purge_after` is nullable** because the retention period
 *   is still an open client question (BR-14 defers to a privacy policy we do not
 *   have). It is set when the request is confirmed, not at insert.
 *
 * Native enums rather than text + CHECK: every set here is closed by the
 * specification, and kysely-codegen turns a Postgres enum into a string-literal
 * union instead of a bare `string`, which is the difference between a typed and
 * an untyped boundary. Extending one later is `ALTER TYPE ... ADD VALUE`, which
 * must not run in the same transaction that uses the new value - so add the
 * value in its own migration.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createType('locale_code')
    .asEnum(['uz-Latn', 'uz-Cyrl', 'ru', 'en'])
    .execute();

  await db.schema
    .createType('user_role')
    .asEnum(['candidate', 'employer', 'admin'])
    .execute();

  await db.schema
    .createType('account_status')
    .asEnum(['active', 'restricted', 'blocked', 'deletion_requested'])
    .execute();

  await db.schema
    .createType('otp_purpose')
    .asEnum(['registration', 'login', 'phone_change', 'device_confirmation'])
    .execute();

  // users -------------------------------------------------------------------
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    // E.164, normalized before insert. Never logged in full (§12.1).
    .addColumn('phone', 'text', (col) => col.notNull().unique())
    .addColumn('locale', sql`locale_code`, (col) =>
      col.notNull().defaultTo('uz-Latn'),
    )
    .addColumn('status', sql`account_status`, (col) =>
      col.notNull().defaultTo('active'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('last_login_at', 'timestamptz')
    .execute();

  // Blocked-account checks (BR-10) and admin user search both filter on status.
  await db.schema
    .createIndex('users_status_idx')
    .on('users')
    .column('status')
    .execute();

  // user_roles --------------------------------------------------------------
  await db.schema
    .createTable('user_roles')
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('role', sql`user_role`, (col) => col.notNull())
    .addColumn('granted_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('user_roles_pkey', ['user_id', 'role'])
    .execute();

  // otp_codes ---------------------------------------------------------------
  await db.schema
    .createTable('otp_codes')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('phone', 'text', (col) => col.notNull())
    .addColumn('purpose', sql`otp_purpose`, (col) => col.notNull())
    // The code itself is never stored (§4.2). Hash only.
    .addColumn('code_hash', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('consumed_at', 'timestamptz')
    // Kept for abuse investigation; per-IP rate limiting itself is not a query
    // over this table.
    .addColumn('requested_ip', sql`inet`)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Resend-delay and verify both need "the newest code for this phone and
  // purpose", which is exactly this index.
  await sql`
    CREATE INDEX otp_codes_phone_purpose_created_idx
      ON otp_codes (phone, purpose, created_at DESC)
  `.execute(db);

  // Only one unconsumed code per (phone, purpose) may exist at a time, so a
  // resend supersedes rather than accumulates. Enforced here, not in a service:
  // two concurrent sends from a retrying mobile client must not both win.
  await sql`
    CREATE UNIQUE INDEX otp_codes_one_active_per_phone_purpose_idx
      ON otp_codes (phone, purpose)
      WHERE consumed_at IS NULL
  `.execute(db);

  // sessions ----------------------------------------------------------------
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    // Rotation chain identity: every session produced by refreshing an earlier
    // one shares its family, so reuse detection can revoke all of them at once.
    .addColumn('family_id', 'uuid', (col) => col.notNull())
    // Hash, never the token. Unique because refresh looks the row up by it.
    .addColumn('refresh_token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('replaced_by_session_id', 'uuid', (col) =>
      col.references('sessions.id').onDelete('set null'),
    )
    .addColumn('device_fingerprint', 'text')
    .addColumn('device_name', 'text')
    .addColumn('platform', 'text')
    .addColumn('app_version', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('last_used_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('revoked_reason', 'text')
    .execute();

  // "List my active sessions" (§4.2) and "revoke all" both read this.
  await sql`
    CREATE INDEX sessions_user_active_idx
      ON sessions (user_id)
      WHERE revoked_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('sessions_family_idx')
    .on('sessions')
    .column('family_id')
    .execute();

  // account_status_history --------------------------------------------------
  await db.schema
    .createTable('account_status_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    // Null on the row written at registration: there is no previous status.
    .addColumn('from_status', sql`account_status`)
    .addColumn('to_status', sql`account_status`, (col) => col.notNull())
    // Null actor means the system acted (registration, automated restriction).
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('actor_role', sql`user_role`)
    .addColumn('reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    CREATE INDEX account_status_history_user_created_idx
      ON account_status_history (user_id, created_at DESC)
  `.execute(db);

  // deletion_requests -------------------------------------------------------
  await db.schema
    .createTable('deletion_requests')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('requested_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('confirmed_at', 'timestamptz')
    .addColumn('cancelled_at', 'timestamptz')
    // Set on confirmation from the configured retention period. Nullable until
    // BR-14's retention policy is answered by the client.
    .addColumn('purge_after', 'timestamptz')
    .addColumn('reason', 'text')
    .execute();

  // One request open at a time. A double-tap on "delete my account" from a
  // flaky connection must fail in the database, not be deduplicated by luck.
  await sql`
    CREATE UNIQUE INDEX deletion_requests_one_open_per_user_idx
      ON deletion_requests (user_id)
      WHERE confirmed_at IS NULL AND cancelled_at IS NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '2', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('deletion_requests').execute();
  await db.schema.dropTable('account_status_history').execute();
  await db.schema.dropTable('sessions').execute();
  await db.schema.dropTable('otp_codes').execute();
  await db.schema.dropTable('user_roles').execute();
  await db.schema.dropTable('users').execute();

  await db.schema.dropType('otp_purpose').execute();
  await db.schema.dropType('account_status').execute();
  await db.schema.dropType('user_role').execute();
  await db.schema.dropType('locale_code').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '1', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
