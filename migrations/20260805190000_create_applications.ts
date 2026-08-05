import { type Kysely, sql } from 'kysely';

/**
 * M6 schema: applications, saved vacancies, complaints and idempotency keys
 * (§5.5, §5.6, §6.5, §8.1, BR-06, BR-07, BR-08).
 *
 * The two rules this file exists to make un-bypassable:
 *
 * - **BR-07 is a partial unique index**, not a service check: `UNIQUE (vacancy_id,
 *   candidate_user_id) WHERE status NOT IN ('withdrawn','rejected')`. A candidate on a
 *   flaky mobile connection double-taps Apply, and two requests race. A service-layer
 *   "does one exist already" loses that race; the database does not. Withdrawn and
 *   rejected applications are excluded so a candidate may apply again later, which is
 *   what "one *active* application" means.
 * - **BR-08 gets `application_stage_history`**, written in the same transaction as
 *   every status change. A status change without its history row is a bug, so the
 *   service writes both or neither.
 *
 * Other decisions worth stating:
 *
 * - **Internal employer notes are their own table** (§6.5 "an internal employer note
 *   that is not visible to the candidate"). On the application row they would be one
 *   forgotten `select` away from reaching the candidate; in a separate table, reading
 *   them is a deliberate act.
 * - **`complaints` is generic from the start** (`target_type` + `target_id`). §5.6
 *   needs a candidate to report a vacancy now, and §10 reviews complaints over users,
 *   vacancies, messages and profiles later. One table with a target discriminator
 *   beats four tables that M10 would have to unify.
 * - **`idempotency_keys` stores a fingerprint, not the response body.** ARCHITECTURE.md
 *   §7: same key + same fingerprint replays the original resource, same key +
 *   different fingerprint is a 409. Storing the resource id and re-reading it keeps one
 *   source of truth for what the client gets back - a cached body would go stale the
 *   moment the resource changed.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // §8.1's eight stages, in progression order. `withdrawn` is the candidate's,
  // everything from `viewed` on is the employer's.
  await db.schema
    .createType('application_status')
    .asEnum([
      'submitted',
      'viewed',
      'shortlisted',
      'interview',
      'offer',
      'hired',
      'rejected',
      'withdrawn',
    ])
    .execute();

  await db.schema
    .createType('complaint_target')
    .asEnum(['vacancy', 'user', 'profile', 'message'])
    .execute();

  await db.schema
    .createType('complaint_status')
    .asEnum(['open', 'dismissed', 'actioned'])
    .execute();

  // applications ------------------------------------------------------------
  await db.schema
    .createTable('applications')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.notNull().references('vacancies.id').onDelete('cascade'),
    )
    // References the candidate *profile*, not the user: BR-02 requires a profile to
    // apply with, and the foreign key makes "an application whose profile does not
    // exist" unrepresentable rather than merely unlikely.
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('status', sql`application_status`, (col) =>
      col.notNull().defaultTo('submitted'),
    )
    // §5.6's Apply action may carry a short message. Optional: a candidate applying to
    // twenty seasonal vacancies will not write twenty letters.
    .addColumn('cover_note', 'text')
    // Set when the employer rejects, and shown to the candidate (§8.1 "optional
    // standard message").
    .addColumn('rejection_reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // BR-07: one *active* application per candidate per vacancy, enforced where a race
  // cannot get past it.
  await sql`
    CREATE UNIQUE INDEX applications_one_active_idx
      ON applications (vacancy_id, candidate_user_id)
      WHERE status NOT IN ('withdrawn', 'rejected')
  `.execute(db);

  // §6.5: applications grouped by vacancy, filtered by status.
  await sql`
    CREATE INDEX applications_vacancy_status_idx
      ON applications (vacancy_id, status, created_at DESC)
  `.execute(db);

  // The candidate's own list (§5.6 shows their statuses).
  await sql`
    CREATE INDEX applications_candidate_created_idx
      ON applications (candidate_user_id, created_at DESC)
  `.execute(db);

  // application_stage_history ----------------------------------------------
  // BR-08: "Every application status change is recorded with time and actor."
  await db.schema
    .createTable('application_stage_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('application_id', 'uuid', (col) =>
      col.notNull().references('applications.id').onDelete('cascade'),
    )
    .addColumn('from_status', sql`application_status`)
    .addColumn('to_status', sql`application_status`, (col) => col.notNull())
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
    CREATE INDEX application_stage_history_application_created_idx
      ON application_stage_history (application_id, created_at DESC)
  `.execute(db);

  // application_notes ------------------------------------------------------
  // §6.5's internal note. A separate table so that reading it is deliberate - see the
  // header note.
  await db.schema
    .createTable('application_notes')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('application_id', 'uuid', (col) =>
      col.notNull().references('applications.id').onDelete('cascade'),
    )
    .addColumn('author_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('note', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'application_notes_not_blank',
      sql`length(btrim(note)) > 0`,
    )
    .execute();

  await sql`
    CREATE INDEX application_notes_application_created_idx
      ON application_notes (application_id, created_at DESC)
  `.execute(db);

  // saved_vacancies --------------------------------------------------------
  // §5.5's "Saved vacancies" and §5.6's Save action.
  await db.schema
    .createTable('saved_vacancies')
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.notNull().references('vacancies.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Saving twice is the same as saving once, so the key makes it idempotent rather
    // than an error the client has to handle.
    .addPrimaryKeyConstraint('saved_vacancies_pkey', [
      'candidate_user_id',
      'vacancy_id',
    ])
    .execute();

  await sql`
    CREATE INDEX saved_vacancies_candidate_created_idx
      ON saved_vacancies (candidate_user_id, created_at DESC)
  `.execute(db);

  // complaints -------------------------------------------------------------
  await db.schema
    .createTable('complaints')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('target_type', sql`complaint_target`, (col) => col.notNull())
    // Deliberately not a foreign key: the target is one of four tables. The reviewing
    // code resolves it by `target_type`, and a complaint must survive the target being
    // removed - otherwise deleting the thing complained about erases the complaint.
    .addColumn('target_id', 'uuid', (col) => col.notNull())
    .addColumn('reporter_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('status', sql`complaint_status`, (col) =>
      col.notNull().defaultTo('open'),
    )
    // M10's review fields, present now so the review is a status change rather than a
    // migration.
    .addColumn('reviewed_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('reviewed_at', 'timestamptz')
    .addColumn('resolution', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'complaints_reason_not_blank',
      sql`length(btrim(reason)) > 0`,
    )
    .execute();

  // One open complaint per reporter per target: a user tapping Report twice is not two
  // complaints, and a moderator should not review the same thing twice.
  await sql`
    CREATE UNIQUE INDEX complaints_one_open_per_reporter_idx
      ON complaints (target_type, target_id, reporter_user_id)
      WHERE status = 'open'
  `.execute(db);

  // M10's queue: oldest open complaint first.
  await sql`
    CREATE INDEX complaints_open_created_idx
      ON complaints (created_at)
      WHERE status = 'open'
  `.execute(db);

  // idempotency_keys -------------------------------------------------------
  await db.schema
    .createTable('idempotency_keys')
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    // Scoped per operation, so the same client-generated key on two different
    // endpoints cannot collide.
    .addColumn('operation', 'text', (col) => col.notNull())
    // A hash of the request that first used this key. Same key + different
    // fingerprint is the client's bug, and answering 409 tells it so.
    .addColumn('fingerprint', 'text', (col) => col.notNull())
    .addColumn('resource_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('idempotency_keys_pkey', [
      'user_id',
      'operation',
      'key',
    ])
    .execute();

  // For the retention sweep: keys expire after a documented window (ARCHITECTURE.md
  // §7), and nothing else queries by age.
  await sql`
    CREATE INDEX idempotency_keys_created_idx
      ON idempotency_keys (created_at)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '10', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();
  await db.schema.dropTable('complaints').execute();
  await db.schema.dropTable('saved_vacancies').execute();
  await db.schema.dropTable('application_notes').execute();
  await db.schema.dropTable('application_stage_history').execute();
  await db.schema.dropTable('applications').execute();

  await db.schema.dropType('complaint_status').execute();
  await db.schema.dropType('complaint_target').execute();
  await db.schema.dropType('application_status').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '9', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
