import { type Kysely, sql } from 'kysely';

/**
 * M5 schema: vacancies, their structured requirements and the status machine
 * (§6.3, §6.4, BR-04, BR-05, BR-06, BR-11, BR-12, BR-08).
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **One `vacancy_requirements` table keyed by the schema field's code**, rather
 *   than a table per requirement group. The candidate side splits skills and
 *   languages into their own tables because *candidates* are what search filters and
 *   ranks, and those filters need per-item indexes. A vacancy's requirements are read
 *   the other way round: fetched whole for one vacancy, to render it, to prefill a
 *   search (UAT-06), or to score a candidate against it. That is one indexed read of
 *   one vacancy's rows, so five tables would buy nothing and cost five joins.
 * - **`level_rank` is denormalized here too**, so "candidates with Russian at this
 *   vacancy's level or better" compares two ranks without joining the dictionary
 *   twice.
 * - **`is_mandatory` distinguishes a requirement from a preference** (§6.3 "language
 *   requirements: mandatory/preferred flag"). It applies to any requirement, not only
 *   languages: M7's match score needs to know which misses disqualify and which
 *   merely lower the score.
 * - **`category` is derived from the occupation**, exactly as on a candidate profile,
 *   and rewritten on every write. §6.3 lists both, but two independent values would
 *   let a vacancy claim a category its occupation contradicts.
 * - **`starts_on IS NULL` means "immediately"** (§6.3 "Start date or immediately").
 *   A separate boolean would allow the contradiction of "immediately, from March".
 * - **BR-05 is a CHECK**, not a service rule: `worker_count >= 1`.
 * - **BR-12 is a CHECK too.** Any age or gender restriction requires a justification
 *   code in the same row. A service-only rule would leave the admin path and a manual
 *   SQL fix free to write a restriction with no stated reason, which is the one thing
 *   BR-12 forbids.
 * - **BR-11 is a status filter, never a delete.** `closed` leaves discovery and stays
 *   in history, which is what the partial indexes below express: discovery reads only
 *   `status = 'active'`.
 * - **Every transition writes `vacancy_status_history`** (BR-08), in the same
 *   transaction as the status change.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // §6.4's states. `rejected` returns to `draft` for editing, which is why it is a
  // state and not simply a reason on `draft`.
  await db.schema
    .createType('vacancy_status')
    .asEnum([
      'draft',
      'under_moderation',
      'active',
      'paused',
      'closed',
      'rejected',
    ])
    .execute();

  // vacancies ---------------------------------------------------------------
  await db.schema
    .createTable('vacancies')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    // Derived from the occupation; drives the §5.2-style field set for the form.
    .addColumn('category', sql`dictionary_category`)
    .addColumn('occupation_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('title', 'text')
    .addColumn('description', 'text')
    // BR-05. Nullable while a draft is being written; the CHECK bites on any stored
    // value and the submit path requires one.
    .addColumn('worker_count', 'integer')
    // §6.5 counts hires against the requirement. Maintained by M6's application
    // stage moves; zero until then.
    .addColumn('hired_count', 'integer', (col) => col.notNull().defaultTo(0))
    // --- location (§6.3) ---
    .addColumn('region_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('district_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('address', 'text')
    // --- payment (§6.3, API_CONTRACTS.md §4.3) ---
    .addColumn('salary_from', 'numeric(14, 2)')
    .addColumn('salary_to', 'numeric(14, 2)')
    .addColumn('salary_period_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('salary_is_negotiable', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    // --- dates (§6.3) ---
    // Null means "immediately". See the header note.
    .addColumn('starts_on', 'date')
    .addColumn('ends_on', 'date')
    // BR-06: no applications after this date.
    .addColumn('deadline_on', 'date')
    // --- BR-12 conditional restrictions ---
    .addColumn('age_min', 'integer')
    .addColumn('age_max', 'integer')
    .addColumn('gender_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    // A `restriction_justification` dictionary item, not free text: BR-12 requires
    // moderation to *validate* the reason, and prose cannot be validated. The note is
    // the employer's elaboration for the reviewer to read - it is never the
    // justification itself.
    .addColumn('restriction_justification_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('restriction_justification_note', 'text')
    // --- status (§6.4) ---
    .addColumn('status', sql`vacancy_status`, (col) =>
      col.notNull().defaultTo('draft'),
    )
    // The moderator's reason for a rejection or a correction request, shown to the
    // employer as written.
    .addColumn('moderation_reason', 'text')
    .addColumn('published_at', 'timestamptz')
    .addColumn('closed_at', 'timestamptz')
    .addColumn('closure_reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // BR-05: "The required worker count must be at least one."
    .addCheckConstraint(
      'vacancies_worker_count_positive',
      sql`worker_count IS NULL OR worker_count >= 1`,
    )
    .addCheckConstraint(
      'vacancies_hired_count_non_negative',
      sql`hired_count >= 0`,
    )
    // BR-12: a restriction cannot exist without a stated, enumerable reason.
    .addCheckConstraint(
      'vacancies_restriction_needs_justification',
      sql`(age_min IS NULL AND age_max IS NULL AND gender_id IS NULL)
          OR restriction_justification_id IS NOT NULL`,
    )
    .addCheckConstraint(
      'vacancies_age_range_order',
      sql`age_min IS NULL OR age_max IS NULL OR age_min <= age_max`,
    )
    // 14 is the platform's lower bound, as on a candidate's birth date.
    .addCheckConstraint(
      'vacancies_age_plausible',
      sql`(age_min IS NULL OR age_min BETWEEN 14 AND 100)
          AND (age_max IS NULL OR age_max BETWEEN 14 AND 100)`,
    )
    .addCheckConstraint(
      'vacancies_salary_negotiable_empty',
      sql`NOT salary_is_negotiable OR (salary_from IS NULL AND salary_to IS NULL)`,
    )
    .addCheckConstraint(
      'vacancies_salary_order',
      sql`salary_from IS NULL OR salary_to IS NULL OR salary_from <= salary_to`,
    )
    .addCheckConstraint(
      'vacancies_salary_non_negative',
      sql`(salary_from IS NULL OR salary_from >= 0) AND (salary_to IS NULL OR salary_to >= 0)`,
    )
    .addCheckConstraint(
      'vacancies_date_order',
      sql`ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on`,
    )
    // A published vacancy has a publication time, and §5.5 sorts discovery by it.
    .addCheckConstraint(
      'vacancies_published_at_present',
      sql`status NOT IN ('active', 'paused', 'closed') OR published_at IS NOT NULL`,
    )
    .addCheckConstraint(
      'vacancies_closed_at_present',
      sql`(status = 'closed') = (closed_at IS NOT NULL)`,
    )
    .execute();

  // Discovery (§5.5, BR-11): only active vacancies, newest first. Partial, because a
  // closed vacancy must never appear here - which is BR-11 expressed as an index
  // rather than as a filter each query has to remember.
  await sql`
    CREATE INDEX vacancies_active_discovery_idx
      ON vacancies (category, region_id, published_at DESC)
      WHERE status = 'active'
  `.execute(db);

  // The recommended feed matches on occupation first (§5.5).
  await sql`
    CREATE INDEX vacancies_active_occupation_idx
      ON vacancies (occupation_id, published_at DESC)
      WHERE status = 'active'
  `.execute(db);

  // BR-06's sweep: active vacancies whose deadline has passed.
  await sql`
    CREATE INDEX vacancies_active_deadline_idx
      ON vacancies (deadline_on)
      WHERE status = 'active' AND deadline_on IS NOT NULL
  `.execute(db);

  // The employer's own list, all statuses (BR-11 keeps closed ones in history).
  await sql`
    CREATE INDEX vacancies_employer_status_idx
      ON vacancies (employer_user_id, status, updated_at DESC)
  `.execute(db);

  // M10's moderation queue, oldest first (BR-04).
  await sql`
    CREATE INDEX vacancies_moderation_queue_idx
      ON vacancies (updated_at)
      WHERE status = 'under_moderation'
  `.execute(db);

  // vacancy_requirements ----------------------------------------------------
  await db.schema
    .createTable('vacancy_requirements')
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.notNull().references('vacancies.id').onDelete('cascade'),
    )
    // The schema field's code, so the uniform write routes straight here.
    .addColumn('field_code', 'text', (col) => col.notNull())
    .addColumn('item_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    // Set on a leveled requirement: "Russian, at least C1".
    .addColumn('level_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('level_rank', 'integer')
    // §6.3's mandatory/preferred flag. Mandatory by default: a requirement stated
    // without qualification is one the employer means.
    .addColumn('is_mandatory', 'boolean', (col) =>
      col.notNull().defaultTo(true),
    )
    .addColumn('value_bool', 'boolean')
    .addColumn('value_int', 'integer')
    .addColumn('value_decimal', 'numeric(14, 2)')
    .addColumn('value_text', 'text')
    .addColumn('value_date', 'date')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Exactly one payload per row, as on `candidate_attributes`: a field whose kind
    // changed must not leave two values behind for readers to choose between.
    .addCheckConstraint(
      'vacancy_requirements_exactly_one_value',
      sql`(
        (item_id IS NOT NULL)::int
        + (value_bool IS NOT NULL)::int
        + (value_int IS NOT NULL)::int
        + (value_decimal IS NOT NULL)::int
        + (value_text IS NOT NULL)::int
        + (value_date IS NOT NULL)::int
      ) = 1`,
    )
    .addCheckConstraint(
      'vacancy_requirements_rank_with_level',
      sql`(level_id IS NULL) = (level_rank IS NULL)`,
    )
    // A level belongs to a selected item, never to a scalar.
    .addCheckConstraint(
      'vacancy_requirements_level_needs_item',
      sql`level_id IS NULL OR item_id IS NOT NULL`,
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX vacancy_requirements_scalar_idx
      ON vacancy_requirements (vacancy_id, field_code)
      WHERE item_id IS NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX vacancy_requirements_multi_idx
      ON vacancy_requirements (vacancy_id, field_code, item_id)
      WHERE item_id IS NOT NULL
  `.execute(db);

  // vacancy_status_history --------------------------------------------------
  // BR-08 for the vacancy machine, same shape as the employer and account histories.
  await db.schema
    .createTable('vacancy_status_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.notNull().references('vacancies.id').onDelete('cascade'),
    )
    .addColumn('from_status', sql`vacancy_status`)
    .addColumn('to_status', sql`vacancy_status`, (col) => col.notNull())
    // Null means the system acted; `reason` says which rule did.
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
    CREATE INDEX vacancy_status_history_vacancy_created_idx
      ON vacancy_status_history (vacancy_id, created_at DESC)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '9', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('vacancy_status_history').execute();
  await db.schema.dropTable('vacancy_requirements').execute();
  await db.schema.dropTable('vacancies').execute();

  await db.schema.dropType('vacancy_status').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '8', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
