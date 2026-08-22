import type { ExecutionContext } from '@nestjs/common';
import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';

import { AccountStatusGuard, MUTATING_METHODS } from './account-status.guard';

/**
 * BR-10 against a real Postgres: **a blocked account is refused every mutation.**
 *
 * The behavioural half of the pair. `api-surface.spec.ts` asserts the *set* property - that
 * every mutating method the product routes is one this guard recognises - and this asserts what
 * happens when it does: each kind of mutation refused, and reads left open.
 *
 * It cannot be a unit test, because the whole point of this guard is that it **reads the
 * database on every request**. Blocking somebody has to take effect immediately rather than
 * when their access token happens to expire, so the status is not in the token and a mocked
 * database would be testing the opposite design.
 *
 * The methods are enumerated from `MUTATING_METHODS` itself rather than written out, so a fifth
 * one added to the guard is automatically covered here instead of quietly untested.
 *
 * Not repeated here, because they already have homes: the expired-restriction lift with its
 * null-actor history row (`admin.int.spec.ts`), and the end-to-end block through real service
 * calls (`uat.int.spec.ts`, UAT-14).
 */

let db: Database;
let destroy: () => Promise<void>;
let guard: AccountStatusGuard;

const users: string[] = [];

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  guard = new AccountStatusGuard(db);
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

/** A request as the guard reads one: it needs only the user and the method. */
function request(userId: string, method: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: userId }, method }),
    }),
  } as unknown as ExecutionContext;
}

async function newUser(
  status: 'active' | 'blocked' | 'restricted',
  restrictedUntil: 'future' | 'past' | null = null,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = fixturePhone();
    const row = await db
      .insertInto('users')
      .values({
        phone,
        status,
        restricted_until:
          restrictedUntil === 'future'
            ? sql`now() + interval '7 days'`
            : restrictedUntil === 'past'
              ? sql`now() - interval '1 day'`
              : null,
      })
      .onConflict((oc) => oc.column('phone').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!row) {
      continue;
    }

    users.push(row.id);

    return row.id;
  }

  throw new Error('could not find a free test phone number in 20 attempts');
}

describe('a blocked account (BR-10, §10.4)', () => {
  it('is refused on every kind of mutation', async () => {
    const userId = await newUser('blocked');

    // Enumerated from the guard's own set: four today, and a fifth would arrive here for free.
    expect(MUTATING_METHODS.size).toBeGreaterThan(3);

    for (const method of MUTATING_METHODS) {
      await expect(
        guard.canActivate(request(userId, method)),
      ).rejects.toMatchObject({ messageKey: 'account.blocked_action' });
    }
  });

  it('can still read, so they can see why', async () => {
    // §10.4's block is a ban on changing things, not a lockout: an account that could not
    // read could not be told what happened to it, or find the complaint that caused it.
    const userId = await newUser('blocked');

    await expect(guard.canActivate(request(userId, 'GET'))).resolves.toBe(true);
    await expect(guard.canActivate(request(userId, 'HEAD'))).resolves.toBe(
      true,
    );
  });
});

describe('a restricted account (§10.2)', () => {
  it('is refused on every kind of mutation while the restriction stands', async () => {
    // A narrower state than `blocked` - §10.2 makes it temporary - and it carries the same
    // mutation ban, which is the part easy to get wrong by treating it as a warning.
    const userId = await newUser('restricted', 'future');

    for (const method of MUTATING_METHODS) {
      await expect(
        guard.canActivate(request(userId, method)),
      ).rejects.toMatchObject({ messageKey: 'account.restricted_action' });
    }
  });
});

describe('an active account', () => {
  it('is allowed on every method', async () => {
    // The other half of the assertion: a guard that refused everything would pass the tests
    // above and break the product.
    const userId = await newUser('active');

    for (const method of [...MUTATING_METHODS, 'GET']) {
      await expect(guard.canActivate(request(userId, method))).resolves.toBe(
        true,
      );
    }
  });

  it('is allowed when no user is attached at all', async () => {
    // Public routes reach this guard with no user: `AuthorizationGuard` has already decided
    // whether that is allowed, and BR-10 has nothing to check. M13's provider callbacks made
    // this reachable on a *mutating* method for the first time.
    const anonymous = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST' }) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(anonymous)).resolves.toBe(true);
  });
});

describe('an account that no longer exists', () => {
  it('is refused rather than passed through', async () => {
    // A token outliving its account. Refusing is the safe direction: the alternative is a
    // deleted user mutating on the strength of a token nobody can revoke any more.
    const userId = await newUser('active');
    await db.deleteFrom('users').where('id', '=', userId).execute();

    await expect(
      guard.canActivate(request(userId, 'POST')),
    ).rejects.toMatchObject({ messageKey: 'account.gone' });
  });
});
