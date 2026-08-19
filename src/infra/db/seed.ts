/**
 * Dictionary and field-schema seed runner.
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
import { seedSchemaVersions } from '@modules/schemas/seed/schema-version-seed';

import { configuredAdminPhones, seedAdministrators } from './admin-seed';
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

    // Publishes what the field-schema declarations say, so the manifest and the
    // schema ETag report the version the code actually serves.
    const schemas = await seedSchemaVersions(db);
    console.log(`  schema versions   ${schemas.versionsUpdated}`);

    // §10's first administrator, which no route grants on purpose. Silent when the instance
    // has not been told who administers it.
    const adminPhones = configuredAdminPhones();

    if (adminPhones.length > 0) {
      const admins = await seedAdministrators(db, adminPhones);

      console.log('Administrators:');
      console.log(`  accounts created  ${admins.usersCreated}`);
      console.log(`  roles granted     ${admins.rolesGranted}`);
      console.log(`  already admin     ${admins.alreadyAdmin}`);
    } else {
      // Worth saying, because an instance with no administrator parks every employer in
      // `under_review` and nothing explains why.
      console.log(
        'No SEED_ADMIN_PHONES set: nobody can approve employers or moderate vacancies.',
      );
    }

    if (
      report.typesCreated +
        report.itemsCreated +
        report.itemsUpdated +
        report.itemsActivated +
        report.labelsWritten +
        schemas.versionsUpdated ===
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
