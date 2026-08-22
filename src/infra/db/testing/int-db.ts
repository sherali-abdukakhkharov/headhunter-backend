import { randomInt } from 'node:crypto';

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

/**
 * Every fixture phone number is minted here.
 *
 * The old scheme was `Math.random()` over **seven** digits, written out separately in
 * twenty-one specs, and it failed unrelated tests twice in one session with `duplicate key
 * value violates unique constraint "users_phone_key"`. That reads as a flaky test and is a
 * flaky fixture, which is worse: it teaches whoever sees it to re-run rather than to look,
 * and one day it will do that to a real failure.
 *
 * The birthday problem was the smaller half. These specs share one development database
 * that had collected **12 000** fixture users over eighteen days - the suites cannot delete
 * an administrator who acted, because the audit log's actor reference is RESTRICT - so every
 * new number was drawn against thousands of neighbours. Seven digits against twelve
 * thousand rows is roughly one collision per eight hundred inserts, and a full run makes
 * hundreds.
 *
 * So: same idea, enough digits, one copy.
 *
 * - **Eleven random digits, not seven.** Against the few hundred rows a run holds, that is
 *   about one collision in a billion inserts. Still a probability and not a proof, which is
 *   the honest description - but four orders of magnitude past the point where it shows up
 *   in a working day.
 * - **`crypto.randomInt`, not `Math.random`**, because it is uniform over the whole range
 *   rather than over a float's mantissa.
 * - **`+9987` marks a fixture.** Nothing else uses it: the load seeder is `+99800` and the
 *   old scheme was `+9989x`, so a number from here is recognisable as test data in a table
 *   that is shared with a running dev server.
 *
 * Two schemes were tried and thrown away before this one, both trying to *construct*
 * uniqueness from a worker id and a counter. Both failed the same way and it is worth
 * recording: **Jest gives each test file a fresh module registry and a fresh realm**, so
 * neither a module-level `let` nor `globalThis` survives from one spec file to the next.
 * There is no process-wide counter to be had from inside a test.
 *
 * `normalizePhone` accepts the result: it is deliberately permissive about country and
 * operator length (9-15 digits), so a fixture number goes through the real auth path
 * unchanged rather than needing a second one. Fifteen is its upper bound and this sits on
 * it, which `fixture-phone.spec.ts` pins.
 */
const FIXTURE_PHONE_PREFIX = '+9987';
const ELEVEN_DIGITS = 100_000_000_000;

export function fixturePhone(): string {
  return `${FIXTURE_PHONE_PREFIX}${serial()}`;
}

/**
 * A Telegram user id, built the same way and for the same reason.
 *
 * `users.telegram_user_id` is UNIQUE too, so the deprecated login path had the identical
 * flake. The leading `9` keeps these clear of the 500 000 000-600 000 000 range the old
 * scheme drew from, and 12 digits is comfortably inside a safe integer.
 */
export function fixtureTelegramId(): string {
  return `9${serial()}`;
}

function serial(): string {
  return String(randomInt(ELEVEN_DIGITS)).padStart(11, '0');
}
