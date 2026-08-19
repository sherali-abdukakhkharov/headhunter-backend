import { type Kysely, sql } from 'kysely';

/**
 * An account holder's name, for the accounts that have no profile to carry one.
 *
 * **Why `users` did not need this until now.** Every name in the product belonged to a
 * profile: `candidate_profiles.full_name` is a declared schema field (BR-02 counts it
 * toward `is_complete`), `employers.full_name` is the contact on a verification packet, and
 * `companies.public_name` is what a candidate sees. An account was always one of those two
 * things, so "the person's name" and "the profile's name" were the same string and there
 * was nothing left over to store.
 *
 * M10's administrator broke that. §10 is a role, not a profile - an administrator holds no
 * `candidate_profiles` row and no `employers` row - so the seeded administrator arrived as
 * a phone number and nothing else. `AdminUsersService` renders a name with
 * `COALESCE(cp.full_name, c.public_name, e.full_name)`, which is `NULL` for exactly those
 * accounts, and its name filter searched the same three columns. The result: an
 * administrator could not find another administrator by name in §10.2's own user list, only
 * by phone. This column is the missing fourth branch.
 *
 * **It is nullable and stays nullable.** No route sets it; configuration does, through
 * `SEED_ADMIN_PHONES`, which is the only writer. Every account that registers through the
 * app still gets its name from its profile, and this column is `NULL` for all of them -
 * which is why it goes *last* in the `COALESCE` rather than first. A profile name is the
 * one the person maintains; this is the one the deployment was told.
 *
 * **BR-14 owns it too.** `users_purged_has_no_name` is a separate check rather than an
 * extra clause on `users_purged_has_no_credential`: a name is identity, not a credential,
 * and the two rules fail for different reasons. The existing constraint made "purged but
 * still reachable" unrepresentable; this one makes "anonymized but still named"
 * unrepresentable. `RetentionService` clears the column in the same statement as the phone,
 * and the constraint is what turns forgetting to into an error the database raises rather
 * than a name that quietly survives an erasure request.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').addColumn('full_name', 'text').execute();

  await sql`
    ALTER TABLE users ADD CONSTRAINT users_purged_has_no_name CHECK (
      purged_at IS NULL OR full_name IS NULL
    )
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '22', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE users DROP CONSTRAINT users_purged_has_no_name`.execute(
    db,
  );

  await db.schema.alterTable('users').dropColumn('full_name').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '21', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
