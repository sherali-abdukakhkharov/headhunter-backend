import { type Kysely, sql } from 'kysely';

/**
 * M7 schema, first half: what an employer keeps from a candidate search (§7.3).
 *
 * §7.3 gives the candidate card three actions - View profile, Save, Send invitation -
 * and then one sentence that decides these two tables: "Saved candidates can be
 * attached to a vacancy-specific shortlist and receive a private employer note."
 *
 * - **The note lives on the save**, not in a table of its own. It is one note per
 *   employer per candidate, written where the employer already keeps that candidate;
 *   §6.5's `application_notes` is a list because a hiring conversation accumulates
 *   remarks over stages, and a saved-candidate note does not. This is the KISS reading
 *   of the sentence, and it means "note without saving" is unrepresentable rather than
 *   a state some endpoint has to decide about.
 * - **The shortlist is keyed by vacancy**, not by employer, because "vacancy-specific"
 *   is the whole point of it: the same saved candidate belongs on the shortlist for one
 *   opening and not another. Ownership of the shortlist is the ownership of its vacancy,
 *   so there is no employer column to disagree with the vacancy's.
 *
 * Deliberately *not* enforced: that a shortlisted candidate is first saved. §7.3
 * describes the flow a user takes, and a foreign key demanding it would only make a
 * two-tap action fail for a reason no rule cares about.
 *
 * Both candidate references point at `candidate_profiles.user_id` rather than
 * `users.id`, as `applications` does: an employer saves a *profile* they found in
 * search, and a save whose profile does not exist should be unrepresentable.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // saved_candidates --------------------------------------------------------
  await db.schema
    .createTable('saved_candidates')
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    // §7.3's "private employer note". Private is structural: no candidate-facing read
    // in this product selects from this table, and the candidate's own profile reads
    // do not join it.
    .addColumn('note', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Saving twice is saving once, as with `saved_vacancies`: the key makes that
    // idempotent instead of an error the client has to handle.
    .addPrimaryKeyConstraint('saved_candidates_pkey', [
      'employer_user_id',
      'candidate_user_id',
    ])
    .addCheckConstraint(
      'saved_candidates_note_not_blank',
      sql`note IS NULL OR length(btrim(note)) > 0`,
    )
    .execute();

  // The employer's own list, newest save first.
  await sql`
    CREATE INDEX saved_candidates_employer_created_idx
      ON saved_candidates (employer_user_id, created_at DESC)
  `.execute(db);

  // vacancy_shortlists ------------------------------------------------------
  await db.schema
    .createTable('vacancy_shortlists')
    .addColumn('vacancy_id', 'uuid', (col) =>
      col.notNull().references('vacancies.id').onDelete('cascade'),
    )
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('vacancy_shortlists_pkey', [
      'vacancy_id',
      'candidate_user_id',
    ])
    .execute();

  await sql`
    CREATE INDEX vacancy_shortlists_vacancy_created_idx
      ON vacancy_shortlists (vacancy_id, created_at DESC)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '11', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('vacancy_shortlists').execute();
  await db.schema.dropTable('saved_candidates').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '10', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
