import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { Database } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';
import { configurePgTypeParsers } from '@infra/db/pg-types';

/**
 * Connects an integration spec to the development database.
 *
 * Only `*.int.spec.ts` files use this - `pnpm test` stays database-free and runs
 * over `DummyDriver` instead. Kept here rather than repeated per spec because the
 * pool options (a short connect timeout above all) decide whether a missing
 * database fails in five seconds or hangs the suite.
 */
export function createIntTestDb(): {
  db: Database;
  destroy: () => Promise<void>;
} {
  dotenv.config({ quiet: true });
  // Same parsers as the running service, or a date-only column behaves
  // differently under test than in production - see `pg-types.ts`.
  configurePgTypeParsers();

  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    // 5435, not 5432: this machine runs several other Postgres instances.
    port: Number(process.env.DB_PORT ?? 5435),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  // `db.destroy()` ends the pool too, so the spec's afterAll needs one call.
  return { db, destroy: () => db.destroy() };
}
