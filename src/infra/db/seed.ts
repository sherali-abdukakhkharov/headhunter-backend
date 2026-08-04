/**
 * Dictionary seed runner.
 *
 *   pnpm seed
 *
 * Runs standalone via tsx, like the migration runner, so a release job can
 * populate dictionaries without booting the app.
 *
 * Deliberately **not** a migration. Dictionary content is reviewed and revised by
 * the client (§13.2), so it changes far more often than the schema does; as a
 * migration, every corrected label would need a new file and could never be
 * corrected in place. The seeder is idempotent instead - re-running after an edit
 * applies exactly the difference.
 */
import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { seedDictionaries } from '@modules/dictionaries/seed/dictionary-seed';

import type { DB } from './database.types';

dotenv.config();

async function main(): Promise<void> {
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  try {
    const report = await seedDictionaries(db);

    console.log('Dictionary seed applied:');
    console.log(`  types created     ${report.typesCreated}`);
    console.log(`  items created     ${report.itemsCreated}`);
    console.log(`  items updated     ${report.itemsUpdated}`);
    console.log(`  items activated   ${report.itemsActivated}`);
    console.log(`  labels written    ${report.labelsWritten}`);

    if (
      report.typesCreated +
        report.itemsCreated +
        report.itemsUpdated +
        report.itemsActivated +
        report.labelsWritten ===
      0
    ) {
      // Worth saying out loud: it means no dictionary version moved, so no
      // client will refetch anything.
      console.log('  (nothing changed - no revision was bumped)');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
