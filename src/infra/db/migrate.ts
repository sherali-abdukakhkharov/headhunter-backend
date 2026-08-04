/**
 * Kysely migration runner.
 *
 *   pnpm migrate:latest    apply every pending migration
 *   pnpm migrate:up        apply the next pending migration
 *   pnpm migrate:down      roll back the most recent migration
 *   pnpm migrate:status    list migrations and whether they are applied
 *
 * Runs standalone via tsx - deliberately independent of the Nest container so
 * migrations can execute in CI or a release job without booting the app.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
// Kysely 0.29 moved the migrator out of the package root into this subpath.
import type { Migration, MigrationProvider } from 'kysely/migration';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';

import type { DB } from './database.types';

dotenv.config();

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

const MIGRATION_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/**
 * Loads migrations from disk.
 *
 * Kysely's built-in FileMigrationProvider is not used because it calls
 * `import()` with a bare filesystem path. On Windows that path looks like
 * `D:\...`, which Node's ESM loader rejects with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `D:` as an unknown URL scheme).
 * Converting to a proper file:// URL first is the fix.
 */
class FileUrlMigrationProvider implements MigrationProvider {
  constructor(private readonly folder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const entries = await fs.readdir(this.folder);

    for (const entry of entries.sort()) {
      if (!MIGRATION_FILE.test(entry) || entry.endsWith('.d.ts')) {
        continue;
      }

      const url = pathToFileURL(path.join(this.folder, entry)).href;
      const loaded = (await import(url)) as Migration;

      // Migration name excludes the extension so the recorded name stays
      // stable whether the file is executed as .ts or compiled .js.
      migrations[entry.replace(MIGRATION_FILE, '')] = loaded;
    }

    return migrations;
  }
}

type Command = 'latest' | 'up' | 'down' | 'status';

function parseCommand(value: string | undefined): Command {
  if (
    value === 'latest' ||
    value === 'up' ||
    value === 'down' ||
    value === 'status'
  ) {
    return value;
  }

  throw new Error(
    `Unknown command "${value ?? ''}". Use one of: latest, up, down, status.`,
  );
}

function createDb(): Kysely<DB> {
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });

  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const db = createDb();

  const migrator = new Migrator({
    db,
    provider: new FileUrlMigrationProvider(MIGRATIONS_DIR),
  });

  try {
    if (command === 'status') {
      const migrations = await migrator.getMigrations();

      if (migrations.length === 0) {
        console.log('No migrations found in', MIGRATIONS_DIR);
        return;
      }

      for (const m of migrations) {
        const state = m.executedAt
          ? `applied  ${m.executedAt.toISOString()}`
          : 'pending';
        console.log(`${state.padEnd(34)} ${m.name}`);
      }
      return;
    }

    const { error, results } =
      command === 'latest'
        ? await migrator.migrateToLatest()
        : command === 'up'
          ? await migrator.migrateUp()
          : await migrator.migrateDown();

    for (const r of results ?? []) {
      if (r.status === 'Success') {
        console.log(`OK      ${r.migrationName} (${r.direction})`);
      } else if (r.status === 'Error') {
        console.error(`FAILED  ${r.migrationName} (${r.direction})`);
      }
    }

    if (error) {
      console.error('Migration failed:', error);
      throw new Error('Migration failed');
    }

    if ((results ?? []).length === 0) {
      console.log('Nothing to do - already up to date.');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
