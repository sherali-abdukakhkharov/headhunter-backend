import { type Kysely, sql } from 'kysely';

/**
 * M7 schema, second half: direct employer invitations (§8.2, §7.3's third card action).
 *
 * §8.2 in one sentence: "An employer may invite a search-visible candidate to an active
 * vacancy **or** send a general work invitation containing occupation, location,
 * schedule, payment, and contact context." Three decisions follow from it.
 *
 * - **The two shapes are exclusive, and the schema says so.** A vacancy invitation reads
 *   its occupation, place and pay from the vacancy; a general one carries its own. A
 *   CHECK requires exactly one of `vacancy_id` and `occupation_id`, so "an invitation to
 *   a vacancy that also states a different occupation" is unrepresentable rather than a
 *   case every reader has to handle. Same reasoning as the `employers` / `companies`
 *   split in M4: which fields must be filled becomes a property of the schema.
 * - **One open invitation per employer, candidate and vacancy**, as a partial unique
 *   index - BR-07's shape, for the reason BR-07 has it: a mobile client double-taps and
 *   two requests race, and a service-layer check loses that race. `NULLS NOT DISTINCT`
 *   is what makes it cover general invitations too, where `vacancy_id` is null and two
 *   nulls would otherwise be different values. A declined or accepted invitation frees
 *   the slot, so an employer may invite again later.
 * - **Every status change writes a history row** (BR-08's rule, applied beyond
 *   applications because CLAUDE.md makes it structural): same columns as
 *   `application_stage_history`, `vacancy_status_history` and
 *   `employer_verification_history`, so an auditor reads one layout everywhere.
 *
 * The candidate's own reply is `response_note`: §8.2's "Request details" is a question,
 * and a question with no room for the question is a button that tells the employer
 * nothing.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // §8.2's three candidate responses, plus the state an invitation starts in.
  // Deliberately no `withdrawn` or `expired`: neither is in the specification, and a
  // status nothing sets is a branch every reader has to consider for nothing.
  await db.schema
    .createType('invitation_status')
    .asEnum(['sent', 'details_requested', 'accepted', 'declined'])
    .execute();

  await db.schema
    .createTable('invitations')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    // The candidate *profile*, as with applications: §8.2 invites somebody found in
    // search, and search only ever returns profiles.
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    // Null for a general invitation. Cascade rather than restrict: if the vacancy is
    // gone there is nothing left to invite anyone to.
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.references('vacancies.id').onDelete('cascade'),
    )

    // --- the general invitation's own content (§8.2) ------------------------
    .addColumn('occupation_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('region_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('district_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('salary_from', 'numeric(14, 2)')
    .addColumn('salary_to', 'numeric(14, 2)')
    .addColumn('salary_period_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('salary_is_negotiable', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    // §8.2's "schedule". Free text rather than a dictionary reference: a general
    // invitation is a message, not a vacancy, and the structured version of this is
    // exactly what publishing a vacancy is for.
    .addColumn('schedule_note', 'text')

    // §8.2's "contact context" - what the employer wants to say. Optional for a vacancy
    // invitation, which speaks for itself.
    .addColumn('message', 'text')

    .addColumn('status', sql`invitation_status`, (col) =>
      col.notNull().defaultTo('sent'),
    )
    // The candidate's reply, and the room "Request details" needs to be a question.
    .addColumn('response_note', 'text')
    .addColumn('responded_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )

    // Exactly one of the two shapes of §8.2.
    .addCheckConstraint(
      'invitations_one_shape',
      sql`(vacancy_id IS NOT NULL AND occupation_id IS NULL)
          OR (vacancy_id IS NULL AND occupation_id IS NOT NULL)`,
    )
    // The same two money rules the candidate profile and the vacancy carry, so a figure
    // means the same thing wherever it appears.
    .addCheckConstraint(
      'invitations_negotiable_excludes_range',
      sql`NOT (salary_is_negotiable AND (salary_from IS NOT NULL OR salary_to IS NOT NULL))`,
    )
    .addCheckConstraint(
      'invitations_salary_order',
      sql`salary_from IS NULL OR salary_to IS NULL OR salary_from <= salary_to`,
    )
    // A response time is present exactly when there has been a response - the same shape
    // as M4's `verified_at`, and for the same reason: a timestamp that can disagree with
    // the status it belongs to will.
    .addCheckConstraint(
      'invitations_responded_at_matches_status',
      sql`(status = 'sent') = (responded_at IS NULL)`,
    )
    .execute();

  // §8.2, and BR-07's shape. `NULLS NOT DISTINCT` is load-bearing: without it two
  // general invitations to the same candidate would both be "open", because their null
  // `vacancy_id` values would count as different.
  await sql`
    CREATE UNIQUE INDEX invitations_one_open_idx
      ON invitations (employer_user_id, candidate_user_id, vacancy_id)
      NULLS NOT DISTINCT
      WHERE status IN ('sent', 'details_requested')
  `.execute(db);

  // The candidate's inbox, newest first.
  await sql`
    CREATE INDEX invitations_candidate_created_idx
      ON invitations (candidate_user_id, created_at DESC)
  `.execute(db);

  // The employer's sent list, and §7.4's "track invited, accepted, interviewed and hired
  // counts" per vacancy.
  await sql`
    CREATE INDEX invitations_employer_created_idx
      ON invitations (employer_user_id, created_at DESC)
  `.execute(db);

  await sql`
    CREATE INDEX invitations_vacancy_status_idx
      ON invitations (vacancy_id, status)
      WHERE vacancy_id IS NOT NULL
  `.execute(db);

  // BR-09's second interaction is "this employer invited the candidate and they
  // accepted", read on every candidate view and every file download.
  await sql`
    CREATE INDEX invitations_accepted_pair_idx
      ON invitations (employer_user_id, candidate_user_id)
      WHERE status = 'accepted'
  `.execute(db);

  // invitation_status_history ----------------------------------------------
  await db.schema
    .createTable('invitation_status_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('invitation_id', 'uuid', (col) =>
      col.notNull().references('invitations.id').onDelete('cascade'),
    )
    .addColumn('from_status', sql`invitation_status`)
    .addColumn('to_status', sql`invitation_status`, (col) => col.notNull())
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
    CREATE INDEX invitation_status_history_invitation_created_idx
      ON invitation_status_history (invitation_id, created_at DESC)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '12', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('invitation_status_history').execute();
  await db.schema.dropTable('invitations').execute();
  await db.schema.dropType('invitation_status').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '11', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
