import { type Kysely, sql } from 'kysely';

/**
 * Creates the `app_meta` key/value table and seeds the schema version.
 *
 * This exists so the migration runner has real work to do on a fresh database
 * and `/health` has something to read. Domain tables (users, vacancies,
 * applications) come in later migrations.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_meta')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db
    .insertInto('app_meta')
    .values([{ key: 'schema_version', value: '1' }])
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('app_meta').execute();
}
