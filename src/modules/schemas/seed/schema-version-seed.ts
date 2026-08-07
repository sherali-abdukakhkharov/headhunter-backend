import type { Database } from '@infra/db/database.module';

import { CANDIDATE_PROFILE_SCHEMA } from '../candidate-profile.schema';
import { VACANCY_SCHEMA } from '../vacancy.schema';
import type { FieldSchemaDefinition } from '../schema-types';

/**
 * Publishes the version each field schema declares in code.
 *
 * The declaration is the source of truth; `schema_versions` is how clients learn
 * of it, through `GET /dictionaries/manifest` and the schema ETag. Copying the
 * number rather than deriving it from the file's contents is deliberate: not every
 * edit needs a refetch (a comment, a reordering), and a content hash would make
 * every one of them invalidate every client's cached form.
 *
 * Idempotent, and for the same reason as the dictionary seeder: a version rewritten
 * to its current value would still be a change if anything watched the row, and
 * re-running a deployment must not tell clients to refetch.
 *
 * A target's five category rows move together. Per-category versions are possible -
 * the table is keyed for them - but a change to the seasonal field set is rare
 * enough that the extra bookkeeping buys less than the guarantee that all five
 * agree.
 */
const DEFINITIONS: FieldSchemaDefinition[] = [
  CANDIDATE_PROFILE_SCHEMA,
  VACANCY_SCHEMA,
];

export interface SchemaVersionSeedReport {
  versionsUpdated: number;
}

export async function seedSchemaVersions(
  db: Database,
): Promise<SchemaVersionSeedReport> {
  let versionsUpdated = 0;

  for (const definition of DEFINITIONS) {
    const updated = await db
      .updateTable('schema_versions')
      .set({ version: definition.version, updated_at: new Date() })
      .where('target', '=', definition.target)
      .where('version', '!=', definition.version)
      .returning('category')
      .execute();

    versionsUpdated += updated.length;
  }

  return { versionsUpdated };
}
