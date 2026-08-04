import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { Database } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';

import { RateLimitService } from './rate-limit.service';

/**
 * Integration tests against a real Postgres.
 *
 * These cannot be unit tests: the whole limiter is one `INSERT ... ON CONFLICT`
 * whose window arithmetic, reset-on-rollover branch and `RETURNING` are all
 * evaluated by the database. A `DummyDriver` would compile the statement and
 * return nothing, so every assertion here would be vacuous.
 */

dotenv.config();

const CONFIG: Partial<AppEnv> = {
  TOKEN_HASH_PEPPER: 'integration-test-pepper-at-least-32-chars',
  RATE_LIMIT_WINDOW_SECONDS: 3600,
  RATE_LIMIT_OTP_PER_PHONE: 5,
  RATE_LIMIT_OTP_PER_IP: 30,
  RATE_LIMIT_AUTH_PER_PHONE: 20,
  RATE_LIMIT_AUTH_PER_IP: 120,
};

function configService(overrides: Partial<AppEnv> = {}) {
  const values = { ...CONFIG, ...overrides } as Record<string, unknown>;
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnv, true>;
}

let db: Database;
let pool: Pool;

beforeAll(() => {
  pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5435),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });

  db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db.destroy();
});

/** Unique per test so one test's counter cannot bleed into another's. */
function subject(): string {
  return `test-${randomUUID()}`;
}

describe('RateLimitService', () => {
  it('allows up to the limit and refuses the next attempt', async () => {
    const limits = new RateLimitService(db, configService());
    const ip = subject();

    for (let i = 0; i < 5; i += 1) {
      const verdict = await limits.consume('otp', 'ip', ip, 5);
      expect(verdict.allowed).toBe(true);
    }

    const refused = await limits.consume('otp', 'ip', ip, 5);
    expect(refused.allowed).toBe(false);
    // The client needs a number it can wait on, not just a 429.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('counts each bucket separately', async () => {
    const limits = new RateLimitService(db, configService());
    const ip = subject();

    await limits.consume('otp', 'ip', ip, 1);
    expect((await limits.consume('otp', 'ip', ip, 1)).allowed).toBe(false);

    // Exhausting the OTP budget must not lock the caller out of refresh.
    expect((await limits.consume('auth', 'ip', ip, 1)).allowed).toBe(true);
  });

  it('resets when the window rolls over', async () => {
    const limits = new RateLimitService(db, configService());
    const ip = subject();

    await limits.consume('otp', 'ip', ip, 1);
    expect((await limits.consume('otp', 'ip', ip, 1)).allowed).toBe(false);

    // Age the row rather than waiting an hour: rollover is what is under test,
    // not the clock.
    await db
      .updateTable('rate_limit_counters')
      .set({ window_start: sql<Date>`now() - interval '2 hours'` })
      .where('bucket', '=', 'otp')
      .where('subject', '=', ip)
      .execute();

    expect((await limits.consume('otp', 'ip', ip, 1)).allowed).toBe(true);
  });

  it('never stores a phone number in the clear', async () => {
    const limits = new RateLimitService(db, configService());
    const phone = `+99890${Date.now().toString().slice(-7)}`;

    await limits.consume('otp', 'phone', phone, 5);

    const rows = await db
      .selectFrom('rate_limit_counters')
      .select('subject')
      .where('bucket', '=', 'otp')
      .where('subject', 'like', '%_')
      .execute();

    // §12.1: this table must not become a second register of phone numbers.
    expect(rows.map((r) => r.subject)).not.toContain(phone);
  });

  it('keeps one row per subject rather than one per window', async () => {
    const limits = new RateLimitService(db, configService());
    const ip = subject();

    for (let i = 0; i < 3; i += 1) {
      await limits.consume('otp', 'ip', ip, 10);
    }

    const rows = await db
      .selectFrom('rate_limit_counters')
      .select(['hits'])
      .where('bucket', '=', 'otp')
      .where('subject', '=', ip)
      .execute();

    expect(rows).toEqual([{ hits: 3 }]);
  });

  it('serializes concurrent attempts instead of letting both through', async () => {
    const limits = new RateLimitService(db, configService());
    const ip = subject();

    // Read-compare-write would let both of these see zero and both be allowed.
    // The single upsert cannot: one of them is the second hit.
    const verdicts = await Promise.all([
      limits.consume('otp', 'ip', ip, 1),
      limits.consume('otp', 'ip', ip, 1),
    ]);

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(1);
  });

  it('resolves per-bucket limits from configuration', () => {
    const limits = new RateLimitService(
      db,
      configService({ RATE_LIMIT_OTP_PER_PHONE: 7 }),
    );

    expect(limits.rulesFor('otp')).toEqual([
      { key: 'phone', limit: 7 },
      { key: 'ip', limit: 30 },
    ]);
  });
});
