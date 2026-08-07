import { type Kysely, sql } from 'kysely';

/**
 * Retires the free-text `specialization` values (§7.1, BR-13).
 *
 * M7 turned `specialization` from a text field into a `specialization` dictionary
 * reference on both the candidate profile and the vacancy, because §7.1 filters on it and
 * a text filter cannot behave identically in four interface variants (§3.3) - a
 * candidate's `Информатика` would never meet an employer's `Informatika`.
 *
 * No column changes: both sides already stored the value in a generic key/value row
 * (`candidate_attributes`, `vacancy_requirements`), and the new shape uses `item_id`
 * where the old one used `value_text`. What is left behind is the old text, which nothing
 * reads any more.
 *
 * **Deleted rather than migrated.** Mapping prose onto dictionary items is exactly the
 * guesswork the change exists to remove - "Информатика" could be `computer_science` or
 * `information_systems`, and picking one for somebody would put a claim in their profile
 * they did not make. The field is optional and re-picking it is one tap, so the honest
 * outcome is an empty field the owner fills in. A profile's completeness recomputes on
 * its next write.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM candidate_attributes
    WHERE field_code = 'specialization' AND item_id IS NULL
  `.execute(db);

  await sql`
    DELETE FROM vacancy_requirements
    WHERE field_code = 'specialization' AND item_id IS NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '14', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  // Nothing to restore: the values this deleted cannot be reconstructed, and the schema
  // is unchanged either way. Rolling back the code is what reverts the field's shape.
  await db
    .updateTable('app_meta')
    .set({ value: '13', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
