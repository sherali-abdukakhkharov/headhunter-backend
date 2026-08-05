import { type Kysely, sql } from 'kysely';

/**
 * M4 schema: employer profiles and verification (§6.1, BR-03, BR-08).
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **`employers.user_id` is the primary key**, as with candidate profiles: a user
 *   has zero or one employer profile, and a surrogate key would only allow two.
 * - **Company detail is its own table.** §6.1 gives the two employer types
 *   different fields and §12.3 lists `employers` and `companies` as separate
 *   objects. Nullable columns for every company field on a shared table would make
 *   "which of these must be filled" a property of code rather than of the schema,
 *   and an individual employer would carry eight columns that can never apply.
 * - **`verification_status` on the employer is the current state; submissions are
 *   the attempts.** Both are needed: §6.1 shows the employer one status, while an
 *   administrator reviewing a resubmission needs to see what was sent before and
 *   why it was refused. The status is maintained in the same transaction as the
 *   submission that changes it.
 * - **Every transition writes `employer_verification_history`** (BR-08). Including
 *   the automatic one: with no admin module yet, an approval is recorded with a
 *   null actor and an `auto_verified_no_reviewer` reason, so the history never
 *   claims a person reviewed anything.
 * - **One open submission per employer**, as a partial unique index rather than a
 *   service check - a double-tapped submit on a flaky connection is exactly the
 *   case a service check loses.
 * - **`is_complete` is stored**, like the candidate's: BR-03 gates vacancy submit
 *   and invitations on it, so it is read on every such request and must not need
 *   six joins to answer.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createType('employer_type')
    .asEnum(['company', 'individual'])
    .execute();

  // §6.1's five states, exactly. `changes_required` is distinct from `rejected`
  // because the employer's next action differs: fix and resubmit, versus start
  // again - and §6.1 requires the administrator to be able to ask for corrections
  // with a reason.
  await db.schema
    .createType('verification_status')
    .asEnum([
      'not_submitted',
      'under_review',
      'verified',
      'rejected',
      'changes_required',
    ])
    .execute();

  // employers ---------------------------------------------------------------
  await db.schema
    .createTable('employers')
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('type', sql`employer_type`, (col) => col.notNull())
    // Common to both types (§6.1). The contact phone is deliberately separate from
    // `users.phone`: the login identity and the number a candidate should call are
    // not always the same person, and BR-01's verified number must not be
    // overwritten by a business contact detail.
    .addColumn('contact_phone', 'text')
    .addColumn('region_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('district_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('address', 'text')
    // Individual employers: "short description of the requested work" (§6.1).
    // Companies use it as the company description.
    .addColumn('description', 'text')
    // Individual employers only; a company's name lives on `companies`.
    .addColumn('full_name', 'text')
    // --- verification state (§6.1) ---
    .addColumn('verification_status', sql`verification_status`, (col) =>
      col.notNull().defaultTo('not_submitted'),
    )
    // The administrator's reason for a rejection or a correction request. Shown to
    // the employer, so it is user-facing text written by a human - not a key.
    .addColumn('verification_reason', 'text')
    .addColumn('verified_at', 'timestamptz')
    // --- derived (BR-03) ---
    .addColumn('completeness_percent', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('is_complete', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'employers_completeness_range',
      sql`completeness_percent BETWEEN 0 AND 100`,
    )
    // A verified employer must have a verification time, and an unverified one must
    // not carry a stale one - §7 lets only verified employers search, so "when did
    // this become true" has to be answerable.
    .addCheckConstraint(
      'employers_verified_at_present',
      sql`(verification_status = 'verified') = (verified_at IS NOT NULL)`,
    )
    .execute();

  // The §7 search precondition: verified employers only. Partial, because that is
  // the only set the check ever asks about.
  await sql`
    CREATE INDEX employers_verified_idx
      ON employers (user_id)
      WHERE verification_status = 'verified'
  `.execute(db);

  // The M10 review queue: oldest submission first.
  await sql`
    CREATE INDEX employers_under_review_idx
      ON employers (updated_at)
      WHERE verification_status = 'under_review'
  `.execute(db);

  // companies ---------------------------------------------------------------
  await db.schema
    .createTable('companies')
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.primaryKey().references('employers.user_id').onDelete('cascade'),
    )
    // §6.1 "Legal or public name": both, because they differ often enough in
    // Uzbekistan that showing the legal name on a vacancy card would be wrong, and
    // verifying against the public name would be impossible.
    .addColumn('legal_name', 'text')
    .addColumn('public_name', 'text')
    .addColumn('industry_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('contact_person_name', 'text')
    // A stored file of purpose `logo`; `restrict` so deleting the file a company
    // still points at fails loudly instead of blanking the logo.
    .addColumn('logo_file_id', 'uuid', (col) =>
      col.references('stored_files.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // verification_submissions ------------------------------------------------
  await db.schema
    .createTable('verification_submissions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    // The state this attempt reached. `under_review` is the open one; the partial
    // unique index below allows exactly one.
    .addColumn('status', sql`verification_status`, (col) => col.notNull())
    .addColumn('submitted_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('decided_at', 'timestamptz')
    // Null for an automatic decision - see the header note. Not a foreign key
    // failure waiting to happen: the admin account may later be deleted, and the
    // history must survive that (BR-14 keeps audit rows).
    .addColumn('decided_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('reason', 'text')
    .execute();

  await sql`
    CREATE UNIQUE INDEX verification_submissions_one_open_idx
      ON verification_submissions (employer_user_id)
      WHERE status = 'under_review'
  `.execute(db);

  await sql`
    CREATE INDEX verification_submissions_employer_submitted_idx
      ON verification_submissions (employer_user_id, submitted_at DESC)
  `.execute(db);

  // verification_submission_files -------------------------------------------
  // The evidence attached to one attempt. The file's own `purpose_id` says what
  // kind of document it is, so it is not repeated here.
  await db.schema
    .createTable('verification_submission_files')
    .addColumn('submission_id', 'uuid', (col) =>
      col
        .notNull()
        .references('verification_submissions.id')
        .onDelete('cascade'),
    )
    .addColumn('file_id', 'uuid', (col) =>
      col.notNull().references('stored_files.id').onDelete('restrict'),
    )
    .addPrimaryKeyConstraint('verification_submission_files_pkey', [
      'submission_id',
      'file_id',
    ])
    .execute();

  // employer_verification_history -------------------------------------------
  // BR-08 for the verification machine. Same shape as `account_status_history`, on
  // purpose: an auditor reading either should not have to learn two layouts.
  await db.schema
    .createTable('employer_verification_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    .addColumn('from_status', sql`verification_status`)
    .addColumn('to_status', sql`verification_status`, (col) => col.notNull())
    // Null means the system acted. The `reason` says which system rule did.
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
    CREATE INDEX employer_verification_history_employer_created_idx
      ON employer_verification_history (employer_user_id, created_at DESC)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '8', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('employer_verification_history').execute();
  await db.schema.dropTable('verification_submission_files').execute();
  await db.schema.dropTable('verification_submissions').execute();
  await db.schema.dropTable('companies').execute();
  await db.schema.dropTable('employers').execute();

  await db.schema.dropType('verification_status').execute();
  await db.schema.dropType('employer_type').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '7', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
