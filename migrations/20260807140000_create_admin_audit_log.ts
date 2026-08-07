import { type Kysely, sql } from 'kysely';

/**
 * M10 schema: the administrator audit log (§10.4, §11.1) and a restriction that can end.
 *
 * **"Record important administrator actions in an immutable audit log"** (§10.4). Immutable
 * is enforced by the database, not by the absence of a service method: two statement-level
 * triggers refuse `UPDATE` and `DELETE`, and a third refuses `TRUNCATE` - which would
 * otherwise be the one-line way around the first two. A test asserts all three, because
 * "we simply never wrote an update path" is a property of today's code and this has to be
 * a property of the table.
 *
 * Statement-level rather than row-level on purpose: a row trigger never fires for an
 * `UPDATE` that matches nothing, so `UPDATE ... WHERE false` would succeed and report a
 * success it did not perform. A statement trigger refuses the attempt itself.
 *
 * What this log is *for*, given that six tables already record status changes with their
 * actor (BR-08 - accounts, verification, vacancies, applications, invitations,
 * interviews): it is the **cross-cutting** record, the one place "what has this
 * administrator done" and "what was done to this user" can be asked. Two consequences:
 *
 * - For actions that also write a BR-08 history row, that row is the authoritative one -
 *   it is written inside the same transaction as the change it records, and cannot be
 *   lost. The audit row is the index over it.
 * - For actions with **no** history table - a dictionary edit, a complaint resolution, a
 *   warning that changes no status - the audit row *is* the record, so those are written in
 *   the same transaction as the change.
 *
 * `action` and `target_type` are text rather than enums, deliberately: §10.4's "important
 * administrator actions" is an open list, and a new admin capability should not need a
 * migration to be auditable. The trade is that a typo is not caught by the database, so
 * the codes live in one exported constant.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('admin_audit_log')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    // Never `set null` and never cascade: an audit row that forgot who acted is not an
    // audit row. `restrict` means a purge has to answer for the administrator's rows
    // rather than silently taking the trail with them (BR-14 will have to decide how).
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('target_type', 'text', (col) => col.notNull())
    // Not a foreign key: the target is one of five tables, and the row must outlive the
    // thing it is about - the same reasoning `complaints.target_id` uses.
    .addColumn('target_id', 'uuid')
    // §10.2 makes a reason mandatory for most decisions; the service enforces which.
    .addColumn('reason', 'text')
    // What changed, when a reason is not enough on its own: the decision taken, the
    // labels edited, the item merged into. Small by intent - this is a trail, not a
    // second copy of the data.
    .addColumn('details', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // "What did this administrator do", the §10.4 read.
  await sql`
    CREATE INDEX admin_audit_log_actor_created_idx
      ON admin_audit_log (actor_user_id, created_at DESC)
  `.execute(db);

  // "What was done to this user / vacancy / employer" - the question a complaint or an
  // appeal starts from.
  await sql`
    CREATE INDEX admin_audit_log_target_created_idx
      ON admin_audit_log (target_type, target_id, created_at DESC)
  `.execute(db);

  await sql`
    CREATE INDEX admin_audit_log_created_idx
      ON admin_audit_log (created_at DESC)
  `.execute(db);

  // --- immutability (§10.4) -------------------------------------------------
  await sql`
    CREATE FUNCTION admin_audit_log_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'admin_audit_log is append-only: % refused (SPEC 10.4)', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  for (const operation of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    await sql`
      CREATE TRIGGER ${sql.raw(`admin_audit_log_no_${operation.toLowerCase()}`)}
        BEFORE ${sql.raw(operation)} ON admin_audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_log_append_only()
    `.execute(db);
  }

  // --- a restriction that can end (§10.4) ----------------------------------
  // §10.4 asks for a *temporary* restriction. This is the end of it, and
  // `AccountStatusGuard` is what enforces it: the guard already reads the user's row on
  // every mutation, so an expired restriction costs nothing extra to notice - and it
  // lifts the restriction when it does, writing the BR-08 history row for the change.
  //
  // Lazy rather than scheduled because this deployment has no scheduler, and a column
  // that only a cron job nobody runs would act on is worse than none. The trade is
  // stated where it is felt: until the user's next write attempt, their own profile still
  // reads `restricted`.
  await db.schema
    .alterTable('users')
    .addColumn('restricted_until', 'timestamptz')
    .execute();

  // Only ever read for a user who is already restricted, so the index is partial.
  await sql`
    CREATE INDEX users_restriction_expiry_idx
      ON users (restricted_until)
      WHERE status = 'restricted' AND restricted_until IS NOT NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '16', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('restricted_until').execute();
  // The triggers go with the table; the function does not.
  await db.schema.dropTable('admin_audit_log').execute();
  await sql`DROP FUNCTION admin_audit_log_append_only()`.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '15', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
