import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';

import { UsersService } from './users.service';

/**
 * Integration tests against a real Postgres.
 *
 * Run with `pnpm test:int`. The deletion flow is a transaction that writes two
 * tables and depends on a partial unique index (one open request per user), none
 * of which exists without a database.
 */

let db: Database;
let destroy: () => Promise<void>;
let users: UsersService;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  users = new UsersService(db);
});

afterAll(async () => {
  await destroy();
});

/** A bare user row - these tests need no session or OTP. */
async function newUser(): Promise<string> {
  const phone = `+99891${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;

  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

describe('UsersService', () => {
  it('returns identity, status and granted roles together', async () => {
    const userId = await newUser();
    await db
      .insertInto('user_roles')
      .values([
        { user_id: userId, role: 'candidate' },
        { user_id: userId, role: 'employer' },
      ])
      .execute();

    const profile = await users.findProfile(userId);

    expect(profile.status).toBe('active');
    expect([...profile.roles].sort()).toEqual(['candidate', 'employer']);
    expect(profile.phone).toMatch(/^\+998/);
  });

  it('reports a missing account as not found rather than returning nothing', async () => {
    await expect(users.findProfile(randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('persists a locale change on the account (§3.2)', async () => {
    const userId = await newUser();

    expect(await users.updateLocale(userId, 'uz-Cyrl')).toBe('uz-Cyrl');

    // Read back through a fresh query: §3.2 requires the choice to be restored
    // on other signed-in devices, which only holds if it reached the row.
    const stored = await db
      .selectFrom('users')
      .select('locale')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(stored.locale).toBe('uz-Cyrl');
  });

  it('refuses a locale change for an account that no longer exists', async () => {
    await expect(users.updateLocale(randomUUID(), 'ru')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('opens one deletion request and writes the BR-08 audit row', async () => {
    const userId = await newUser();

    await users.requestDeletion(userId, 'found a job');
    // A double-tap from a flaky connection must not open a second request.
    await users.requestDeletion(userId, 'found a job');

    const requests = await db
      .selectFrom('deletion_requests')
      .select(['id', 'purge_after'])
      .where('user_id', '=', userId)
      .execute();

    expect(requests).toHaveLength(1);
    // BR-14 retention is unanswered, so no purge date is invented.
    expect(requests[0].purge_after).toBeNull();

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status', 'actor_user_id'])
      .where('user_id', '=', userId)
      .execute();

    expect(history).toEqual([
      {
        from_status: 'active',
        to_status: 'deletion_requested',
        actor_user_id: userId,
      },
    ]);
  });
});
