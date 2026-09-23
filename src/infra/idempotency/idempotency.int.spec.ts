import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { ForbiddenError } from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';

import {
  ABANDONED_CLAIM_SECONDS,
  fingerprintOf,
  IdempotencyService,
} from './idempotency.service';

/**
 * The claim lifecycle against a real Postgres.
 *
 * Not a unit test, because every property here is a property of a statement: the insert
 * that loses a race, the takeover whose `WHERE` is re-checked under a row lock, the
 * interval arithmetic. A fake query builder would agree with whatever the service
 * assumed about them.
 */

let db: Database;
let destroy: () => Promise<void>;
let service: IdempotencyService;
let userId: string;

const OPERATION = 'application.apply';

beforeAll(async () => {
  ({ db, destroy } = createIntTestDb());
  service = new IdempotencyService(db);

  const user = await db
    .insertInto('users')
    .values({ phone: fixturePhone(), locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();
  userId = user.id;
});

afterAll(async () => {
  // The keys go with the user: `idempotency_keys.user_id` cascades.
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await destroy();
});

/** A `work` that records how often it ran and answers with a fresh id. */
function counted(answer?: () => Promise<string>) {
  const calls = { count: 0 };
  const work = () => {
    calls.count += 1;

    return answer ? answer() : Promise.resolve(randomUUID());
  };

  return { calls, work };
}

/** An unfinished claim of a given age, as a dead process would have left it. */
async function claimLeftBehind(
  key: string,
  request: unknown,
  ageSeconds: number,
): Promise<void> {
  await db
    .insertInto('idempotency_keys')
    .values({
      key,
      user_id: userId,
      operation: OPERATION,
      fingerprint: fingerprintOf(request),
      created_at: sql<Date>`now() - make_interval(secs => ${ageSeconds})`,
    })
    .execute();
}

async function recorded(key: string) {
  return db
    .selectFrom('idempotency_keys')
    .select(['resource_id'])
    .where('user_id', '=', userId)
    .where('operation', '=', OPERATION)
    .where('key', '=', key)
    .executeTakeFirst();
}

describe('IdempotencyService', () => {
  it('replays the recorded result without running the work again', async () => {
    const key = randomUUID();
    const { calls, work } = counted();

    const first = await service.run(key, userId, OPERATION, { a: 1 }, work);
    const replay = await service.run(key, userId, OPERATION, { a: 1 }, work);

    expect(replay).toBe(first);
    expect(calls.count).toBe(1);
  });

  it('refuses a different request under the same key', async () => {
    const key = randomUUID();
    await service.run(key, userId, OPERATION, { a: 1 }, counted().work);

    await expect(
      service.run(key, userId, OPERATION, { a: 2 }, counted().work),
    ).rejects.toMatchObject({ messageKey: 'idempotency.key_reused' });
  });

  it('frees the key when the work refuses, so the retry runs', async () => {
    // Production, 2026-09-23: a new candidate applied before filling in a profile, was
    // refused, filled it in, and was then told "in progress" on every retry - the app
    // keeps its key until a success, and the refused attempt's claim never recorded one.
    const key = randomUUID();
    const request = { vacancyId: randomUUID(), coverNote: null };
    let profileFilled = false;
    const { calls, work } = counted(() =>
      profileFilled
        ? Promise.resolve(randomUUID())
        : Promise.reject(new ForbiddenError('candidate.profile_required')),
    );

    await expect(
      service.run(key, userId, OPERATION, request, work),
    ).rejects.toMatchObject({ messageKey: 'candidate.profile_required' });
    expect(await recorded(key)).toBeUndefined();

    profileFilled = true;
    const id = await service.run(key, userId, OPERATION, request, work);

    expect(calls.count).toBe(2);
    expect(await recorded(key)).toEqual({ resource_id: id });
  });

  it('answers "in progress" while another attempt holds a fresh claim', async () => {
    const key = randomUUID();
    await claimLeftBehind(key, { a: 1 }, 0);
    const { calls, work } = counted();

    await expect(
      service.run(key, userId, OPERATION, { a: 1 }, work),
    ).rejects.toMatchObject({ messageKey: 'idempotency.in_progress' });
    expect(calls.count).toBe(0);
  });

  it('takes over a claim abandoned by a dead attempt', async () => {
    const key = randomUUID();
    await claimLeftBehind(key, { a: 1 }, ABANDONED_CLAIM_SECONDS + 60);
    const { calls, work } = counted();

    const id = await service.run(key, userId, OPERATION, { a: 1 }, work);

    expect(calls.count).toBe(1);
    expect(await recorded(key)).toEqual({ resource_id: id });
  });

  it('does not take over an abandoned claim for a different request', async () => {
    const key = randomUUID();
    await claimLeftBehind(key, { a: 1 }, ABANDONED_CLAIM_SECONDS + 60);
    const { calls, work } = counted();

    await expect(
      service.run(key, userId, OPERATION, { a: 2 }, work),
    ).rejects.toMatchObject({ messageKey: 'idempotency.key_reused' });
    expect(calls.count).toBe(0);
  });

  it('runs the work once for concurrent attempts on a fresh key', async () => {
    const key = randomUUID();
    const { calls, work } = counted(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(randomUUID()), 200)),
    );

    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(() => service.run(key, userId, OPERATION, { a: 1 }, work)),
    );

    expect(calls.count).toBe(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === 'rejected')) {
      expect(outcome.reason).toMatchObject({
        messageKey: 'idempotency.in_progress',
      });
    }
  });

  it('lets exactly one of two concurrent attempts take over an abandoned claim', async () => {
    const key = randomUUID();
    await claimLeftBehind(key, { a: 1 }, ABANDONED_CLAIM_SECONDS + 60);
    const { calls, work } = counted(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(randomUUID()), 200)),
    );

    await Promise.allSettled(
      [1, 2].map(() => service.run(key, userId, OPERATION, { a: 1 }, work)),
    );

    expect(calls.count).toBe(1);
  });
});
