import { type Kysely, sql } from 'kysely';

/**
 * M3 schema: the candidate profile (§5, BR-02, BR-09).
 *
 * The idea the whole table set serves: **structured columns are authoritative
 * for search, and the CV is an attachment** (§1, §5.4). There is no CV parsing
 * anywhere in this product, so anything an employer can filter on has to be a
 * column or a row here.
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **`candidate_profiles.user_id` is the primary key**, not a separate `id`. A
 *   user has zero or one candidate profile, so a surrogate key would only create
 *   a second way to name the same row and a chance for two profiles to exist.
 * - **Skills and languages are rows, not JSON.** "Match all of these skills" is
 *   `HAVING COUNT(DISTINCT item_id) = n` and "Russian at C1 or better" is a range
 *   test on `level_rank`; neither is usefully indexable as JSON containment
 *   (ARCHITECTURE.md §5).
 * - **`level_rank` is copied from the level item's `rank`** on write. The rank is
 *   uniform per level type and never varies per item (API_CONTRACTS.md §3.4), so
 *   this denormalization cannot go stale in a way that changes meaning, and it
 *   keeps `>= C1` a range scan on one index instead of a join per filter.
 * - **`candidate_attributes` is a typed key/value table** keyed by the schema
 *   field's `code`, because §5.2 makes the relevant attribute set vary by
 *   occupation category - a column per attribute would mean a migration per new
 *   work type. One row per scalar field, one row per selected id for a
 *   multi-select, which is what makes an attribute filter an ordinary indexed
 *   join in M7.
 * - **`category` on the profile is derived, not entered.** It is the category of
 *   the primary occupation and is rewritten in the same statement as
 *   `completeness_percent`, because both are answers to "what does this profile
 *   need" and both are read by search. Deriving it per query would mean joining
 *   occupations to know which field set applies.
 * - **`completeness_percent` / `is_complete` are stored** (§7.1 filters on
 *   completeness, ARCHITECTURE.md §4). Recomputing across six child tables per
 *   search row is the whole 3-second first-page budget (§12.4).
 * - **`last_meaningful_update_at` is separate from `updated_at`** (§5.3, §7.3).
 *   Toggling privacy must not make a stale profile look freshly maintained, so
 *   the visibility route deliberately touches only `updated_at`.
 * - **Nothing here is `NOT NULL` except the keys and the derived counters.** A
 *   profile is built up over several screens (§5.3 shows completeness precisely
 *   because it is normal to be half-finished), so requiredness is a property of
 *   the field schema and BR-02's gate, not of the column. The one thing the
 *   database does enforce is that a *stored* value is coherent - hence the range
 *   and date CHECKs below.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // §5.1 Privacy: "Visible in employer search, hidden from global search, or
  // visible only after applying." A closed enum because BR-02's gate and the
  // search predicate are both keyed off it.
  await db.schema
    .createType('profile_visibility')
    .asEnum(['searchable', 'hidden', 'visible_after_apply'])
    .execute();

  // candidate_profiles ------------------------------------------------------
  await db.schema
    .createTable('candidate_profiles')
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    // --- personal (§5.1) ---
    .addColumn('full_name', 'text')
    .addColumn('date_of_birth', 'date')
    // A dictionary reference rather than a native enum, for the same reason as
    // every other selectable value (BR-13, API_CONTRACTS.md §3.1): the field
    // schema has no `enum` kind, BR-12 vacancy restrictions will reference the
    // same ids, and the four labels have to come from somewhere.
    .addColumn('gender_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    // No `photo_file_id`: §5.1's optional profile photo is an attachment like the
    // CV, and its purpose is declared `maxCount: 1`, so "the current photo" is
    // already a single well-defined row - the newest undeleted `stored_files` row
    // of purpose `photo`. A column would be a second answer to that question and
    // something to keep in sync on every upload and delete. If M7's search cards
    // measure the join as too expensive, it comes back then, as the denormalization
    // it would be.
    // --- location (§5.1) ---
    .addColumn('region_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('district_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    // "optional current settlement" - free text on purpose: below district there
    // is no register to make a dictionary from.
    .addColumn('settlement', 'text')
    // Nullable rather than `NOT NULL DEFAULT false`, so "not answered yet" is a
    // state: it is what §5.3's completeness percentage counts, and a column that
    // can never be empty would report a profile as more finished than it is. A
    // search predicate reads `IS TRUE`, which treats null as no.
    .addColumn('willing_to_relocate', 'boolean')
    .addColumn('willing_to_travel', 'boolean')
    // --- derived from the primary occupation; drives the §5.2 field set ---
    .addColumn('category', sql`dictionary_category`)
    // --- job preferences (§5.1) ---
    .addColumn('available_from', 'date')
    // money_range, API_CONTRACTS.md §4.3. numeric(14,2) holds UZS amounts well
    // past any real salary without float rounding.
    .addColumn('salary_from', 'numeric(14, 2)')
    .addColumn('salary_to', 'numeric(14, 2)')
    .addColumn('salary_period_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('salary_is_negotiable', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    // --- privacy (§5.1, §11.1) ---
    // Hidden by default: §11.1 makes visibility an explicit candidate choice, so
    // the safe default is the one that reveals nothing until it is made.
    .addColumn('visibility', sql`profile_visibility`, (col) =>
      col.notNull().defaultTo('hidden'),
    )
    // --- derived state (§5.3) ---
    .addColumn('completeness_percent', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('is_complete', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('last_meaningful_update_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // §4.3: "Negotiable, 5-8M" is a contradiction the salary filter cannot rank,
    // so it is rejected rather than normalized - and rejected here, because a
    // service-only check leaves the admin and seed paths free to write it.
    .addCheckConstraint(
      'candidate_profiles_salary_negotiable_empty',
      sql`NOT salary_is_negotiable OR (salary_from IS NULL AND salary_to IS NULL)`,
    )
    .addCheckConstraint(
      'candidate_profiles_salary_order',
      sql`salary_from IS NULL OR salary_to IS NULL OR salary_from <= salary_to`,
    )
    .addCheckConstraint(
      'candidate_profiles_salary_non_negative',
      sql`(salary_from IS NULL OR salary_from >= 0) AND (salary_to IS NULL OR salary_to >= 0)`,
    )
    .addCheckConstraint(
      'candidate_profiles_completeness_range',
      sql`completeness_percent BETWEEN 0 AND 100`,
    )
    // A future date of birth is a typo, and an implausible age makes the BR-12
    // review meaningless. 14 is the lower bound the platform will consider; the
    // upper one only excludes impossible values.
    .addCheckConstraint(
      'candidate_profiles_birth_date_plausible',
      sql`date_of_birth IS NULL OR date_of_birth BETWEEN '1920-01-01' AND (CURRENT_DATE - INTERVAL '14 years')`,
    )
    .execute();

  // The search entry predicate of ARCHITECTURE.md §5: the cheap, highly
  // selective columns first, so BR-02's gate is an index scan and not a filter
  // over every profile.
  await sql`
    CREATE INDEX candidate_profiles_searchable_idx
      ON candidate_profiles (region_id, category, completeness_percent)
      WHERE visibility = 'searchable' AND is_complete
  `.execute(db);

  // §7.3 sorts by last meaningful update, over the same searchable set.
  await sql`
    CREATE INDEX candidate_profiles_searchable_recent_idx
      ON candidate_profiles (last_meaningful_update_at DESC)
      WHERE visibility = 'searchable' AND is_complete
  `.execute(db);

  // candidate_occupations ---------------------------------------------------
  // §5.1 "One or more occupations/work types selected from the dictionary,
  // professional level where applicable".
  await db.schema
    .createTable('candidate_occupations')
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('item_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('level_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    // Which occupation decides the profile's category, and therefore its form.
    .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('candidate_occupations_pkey', [
      'user_id',
      'item_id',
    ])
    .execute();

  // One primary occupation per profile, in the database: `category` is derived
  // from it, so two primaries would make the derivation depend on row order.
  await sql`
    CREATE UNIQUE INDEX candidate_occupations_one_primary_idx
      ON candidate_occupations (user_id)
      WHERE is_primary
  `.execute(db);

  // ARCHITECTURE.md §5: the occupation filter's semi-join.
  await sql`
    CREATE INDEX candidate_occupations_item_user_idx
      ON candidate_occupations (item_id, user_id)
  `.execute(db);

  // candidate_skills --------------------------------------------------------
  await db.schema
    .createTable('candidate_skills')
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('item_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    // Required, as §5.1 asks for skills "and self-declared proficiency level" -
    // and because a `dictionary_leveled` row carries a level by definition
    // (API_CONTRACTS.md §4.4), so allowing a null here would be a second shape
    // the client never sends and every reader still has to handle.
    .addColumn('level_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    // Copied from the level item's `rank`. See the header note.
    .addColumn('level_rank', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('candidate_skills_pkey', ['user_id', 'item_id'])
    .execute();

  await sql`
    CREATE INDEX candidate_skills_item_rank_idx
      ON candidate_skills (item_id, level_rank)
  `.execute(db);

  // candidate_languages -----------------------------------------------------
  // §5.1 "Language and level A1-C2 or native; certificate details optional".
  await db.schema
    .createTable('candidate_languages')
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('item_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    // Required here, unlike a skill's: §7.4's controlled example is "Russian at
    // C1 or better", so a language without a level cannot answer the search the
    // specification uses as its own worked example.
    .addColumn('level_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('level_rank', 'integer', (col) => col.notNull())
    .addColumn('has_certificate', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('certificate_note', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('candidate_languages_pkey', ['user_id', 'item_id'])
    .execute();

  await sql`
    CREATE INDEX candidate_languages_item_rank_idx
      ON candidate_languages (item_id, level_rank)
  `.execute(db);

  // candidate_experience ----------------------------------------------------
  // §5.1: "Employer/project, role, start/end dates, responsibilities; simplified
  // entry available for informal or seasonal work" - which is why only the role
  // title is required. A seasonal worker often cannot name an employer.
  await db.schema
    .createTable('candidate_experience')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('employer_name', 'text')
    .addColumn('role_title', 'text', (col) => col.notNull())
    .addColumn('occupation_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('started_on', 'date', (col) => col.notNull())
    .addColumn('ended_on', 'date')
    .addColumn('is_current', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('responsibilities', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // "Current" and an end date contradict each other, and total experience -
    // which §7.1 filters on - is computed from these two columns.
    .addCheckConstraint(
      'candidate_experience_current_has_no_end',
      sql`NOT is_current OR ended_on IS NULL`,
    )
    .addCheckConstraint(
      'candidate_experience_date_order',
      sql`ended_on IS NULL OR ended_on >= started_on`,
    )
    .addCheckConstraint(
      'candidate_experience_not_future',
      sql`started_on <= CURRENT_DATE`,
    )
    .execute();

  await sql`
    CREATE INDEX candidate_experience_user_started_idx
      ON candidate_experience (user_id, started_on DESC)
  `.execute(db);

  // candidate_education -----------------------------------------------------
  // §5.1: "optional for work categories where it is not relevant" - so the
  // requiredness lives in the category's field schema, not here.
  await db.schema
    .createTable('candidate_education')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('level_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('institution', 'text')
    .addColumn('specialization', 'text')
    .addColumn('graduation_year', 'integer')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // An open upper bound of +10 years allows a stated expected graduation
    // without accepting a mistyped century.
    .addCheckConstraint(
      'candidate_education_year_plausible',
      sql`graduation_year IS NULL OR graduation_year BETWEEN 1940 AND (EXTRACT(YEAR FROM CURRENT_DATE)::int + 10)`,
    )
    .execute();

  await sql`
    CREATE INDEX candidate_education_user_idx
      ON candidate_education (user_id)
  `.execute(db);

  // candidate_attributes ----------------------------------------------------
  // The §5.2 category fields. `field_code` is the schema field's code, so the
  // uniform write of API_CONTRACTS.md §4.6 routes straight here without a
  // per-field mapping table.
  await db.schema
    .createTable('candidate_attributes')
    .addColumn('user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('field_code', 'text', (col) => col.notNull())
    // Non-null on multi-select rows only: one row per selected dictionary id, so
    // "has this tool" is an indexed join rather than an array containment test.
    .addColumn('item_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('value_bool', 'boolean')
    .addColumn('value_int', 'integer')
    .addColumn('value_decimal', 'numeric(14, 2)')
    .addColumn('value_text', 'text')
    .addColumn('value_date', 'date')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Exactly one of the six payload columns carries the value. Without this a
    // write that changed a field's kind could leave two values behind and every
    // reader would have to guess which one is current.
    .addCheckConstraint(
      'candidate_attributes_exactly_one_value',
      sql`(
        (item_id IS NOT NULL)::int
        + (value_bool IS NOT NULL)::int
        + (value_int IS NOT NULL)::int
        + (value_decimal IS NOT NULL)::int
        + (value_text IS NOT NULL)::int
        + (value_date IS NOT NULL)::int
      ) = 1`,
    )
    .execute();

  // Two partial unique indexes rather than one primary key: a scalar field has
  // one row per profile, a multi-select has one row per selected id, and
  // `item_id` is null in the first case - which a primary key cannot express.
  await sql`
    CREATE UNIQUE INDEX candidate_attributes_scalar_idx
      ON candidate_attributes (user_id, field_code)
      WHERE item_id IS NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX candidate_attributes_multi_idx
      ON candidate_attributes (user_id, field_code, item_id)
      WHERE item_id IS NOT NULL
  `.execute(db);

  // The M7 attribute filter: "everyone whose `tools` include this item".
  await sql`
    CREATE INDEX candidate_attributes_field_item_idx
      ON candidate_attributes (field_code, item_id, user_id)
      WHERE item_id IS NOT NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '7', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('candidate_attributes').execute();
  await db.schema.dropTable('candidate_education').execute();
  await db.schema.dropTable('candidate_experience').execute();
  await db.schema.dropTable('candidate_languages').execute();
  await db.schema.dropTable('candidate_skills').execute();
  await db.schema.dropTable('candidate_occupations').execute();
  await db.schema.dropTable('candidate_profiles').execute();

  await db.schema.dropType('profile_visibility').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '6', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
