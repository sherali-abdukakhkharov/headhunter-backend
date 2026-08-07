import { type Kysely, sql } from 'kysely';

/**
 * M8 schema, second half: interview scheduling (§8.3).
 *
 * §8.3 is a five-row table of fields, and two of its rows are the whole design.
 *
 * - **"Location / link: required according to interview type."** That is a conditional
 *   requirement, and it is a CHECK rather than a service rule: a phone interview with a
 *   meeting link, or an in-person one with neither an address nor a link, is a row no
 *   write path should be able to produce. The constraint states all three shapes
 *   positively, so adding a fourth type means editing it - which is the right amount of
 *   friction for a field that decides whether a candidate can turn up.
 * - **"Date and time: stored in the configured local time zone and shown clearly."**
 *   `timestamptz`, like every other instant in this schema; the platform zone lives in
 *   configuration and the response carries the offset (API_CONTRACTS.md §2). A local
 *   timestamp column would be the one that loses an hour twice a year.
 *
 * An interview hangs off an **application**, not off a candidate: §8.1 makes `interview`
 * a stage of one, and scheduling one moves the application there in the same transaction.
 * A candidate interviewing for two vacancies has two applications and two interviews,
 * which is what an employer running both processes needs.
 *
 * `cancelled` is the one status not in §8.3's list. It is here because the alternative is
 * a stale interview nobody can retract - an employer whose plans change would otherwise
 * have to reschedule to a fiction - and because the candidate must be told. Every other
 * status is one of the two responses §8.3 names.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createType('interview_type')
    .asEnum(['phone', 'in_person', 'external_link'])
    .execute();

  await db.schema
    .createType('interview_status')
    .asEnum(['scheduled', 'confirmed', 'reschedule_requested', 'cancelled'])
    .execute();

  await db.schema
    .createTable('interviews')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('application_id', 'uuid', (col) =>
      col.notNull().references('applications.id').onDelete('cascade'),
    )
    .addColumn('type', sql`interview_type`, (col) => col.notNull())
    .addColumn('scheduled_at', 'timestamptz', (col) => col.notNull())
    // In-person only: where to go.
    .addColumn('location', 'text')
    // External link only: §8.3 keeps this a plain string. §2.4 puts a built-in video
    // engine out of scope, so this is somebody else's meeting URL and nothing more.
    .addColumn('meeting_link', 'text')
    // §8.3's "Instruction: documents or preparation notes".
    .addColumn('instructions', 'text')
    .addColumn('status', sql`interview_status`, (col) =>
      col.notNull().defaultTo('scheduled'),
    )
    // §8.3's "confirm or request another time" - the request needs room to say when.
    .addColumn('response_note', 'text')
    .addColumn('responded_at', 'timestamptz')
    .addColumn('created_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // §8.3's conditional requirement, stated as all three permitted shapes.
    .addCheckConstraint(
      'interviews_location_matches_type',
      sql`(type = 'phone' AND location IS NULL AND meeting_link IS NULL)
          OR (type = 'in_person' AND location IS NOT NULL AND meeting_link IS NULL)
          OR (type = 'external_link' AND meeting_link IS NOT NULL AND location IS NULL)`,
    )
    // A response time is present exactly when there has been a response - the shape M4's
    // `verified_at` and M7's invitations both use, because a timestamp that can disagree
    // with the status beside it eventually will.
    .addCheckConstraint(
      'interviews_responded_at_matches_status',
      sql`(status = 'scheduled') = (responded_at IS NULL)`,
    )
    .execute();

  // The candidate's "my interviews" list and the employer's per-application read.
  await sql`
    CREATE INDEX interviews_application_scheduled_idx
      ON interviews (application_id, scheduled_at DESC)
  `.execute(db);

  // Upcoming interviews, which is the only cross-application query either side makes.
  await sql`
    CREATE INDEX interviews_upcoming_idx
      ON interviews (scheduled_at)
      WHERE status <> 'cancelled'
  `.execute(db);

  // interview_status_history ------------------------------------------------
  // BR-08's rule applied beyond applications, as with invitations: same columns as every
  // other history table, so an auditor reads one layout.
  await db.schema
    .createTable('interview_status_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('interview_id', 'uuid', (col) =>
      col.notNull().references('interviews.id').onDelete('cascade'),
    )
    .addColumn('from_status', sql`interview_status`)
    .addColumn('to_status', sql`interview_status`, (col) => col.notNull())
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
    CREATE INDEX interview_status_history_interview_created_idx
      ON interview_status_history (interview_id, created_at DESC)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '15', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('interview_status_history').execute();
  await db.schema.dropTable('interviews').execute();
  await db.schema.dropType('interview_status').execute();
  await db.schema.dropType('interview_type').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '14', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
