import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';

import { seedAdministrators } from './admin-seed';

/**
 * The seeder against a real Postgres, because every guarantee it makes is the database's.
 *
 * Idempotence is the `(user_id, role)` primary key, not a check in the loop, so a
 * `DummyDriver` test would compile the insert, run nothing, and pass while the second deploy
 * crashed. Same for `users_purged_has_no_name`: it is the reason an anonymized administrator
 * cannot be re-named by a re-seed, and it exists only in the schema.
 *
 * `pnpm seed` runs this on **production** on every deploy, which is the whole reason these
 * cases are worth their runtime: the second run is the normal case, not the edge one.
 */

let db: Database;
let destroy: () => Promise<void>;

const users: string[] = [];

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('user_roles').where('user_id', '=', id).execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

/**
 * A number no other suite uses. The suites deliberately leave rows behind on failure, so a
 * fixed number here would collide with a previous run rather than with a bug.
 */
function uniquePhone(): string {
  const tail = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

  return `+99893${tail}`;
}

async function track(phone: string): Promise<string> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('phone', '=', phone)
    .executeTakeFirstOrThrow();

  users.push(row.id);

  return row.id;
}

describe('seedAdministrators', () => {
  it('creates the account, grants the role and stores the name', async () => {
    const phone = uniquePhone();

    const report = await seedAdministrators(db, [
      { phone, fullName: "Abduqaxxarov Sherali Rasuljon o'g'li" },
    ]);

    expect(report).toEqual({
      usersCreated: 1,
      rolesGranted: 1,
      alreadyAdmin: 0,
      namesWritten: 1,
    });

    const userId = await track(phone);

    const user = await db
      .selectFrom('users')
      .select('full_name')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(user.full_name).toBe("Abduqaxxarov Sherali Rasuljon o'g'li");

    const roles = await db
      .selectFrom('user_roles')
      .select('role')
      .where('user_id', '=', userId)
      .execute();

    expect(roles).toEqual([{ role: 'admin' }]);
  });

  it('normalizes the number, so a loosely written one reaches the login path row', async () => {
    // What `POST /auth/otp/send` would look up for the same person. A missed normalization
    // here creates a second account nobody can sign into, silently.
    const phone = uniquePhone();
    const loose = phone.replace('+', '').replace(/^(\d{5})/, '$1 ');

    await seedAdministrators(db, [{ phone: loose, fullName: null }]);

    const userId = await track(phone);

    expect(userId).toBeTruthy();
  });

  it('is a no-op on the second run, and says so rather than failing', async () => {
    const phone = uniquePhone();
    const entry = { phone, fullName: 'Karimov Anvar' };

    await seedAdministrators(db, [entry]);
    await track(phone);

    const second = await seedAdministrators(db, [entry]);

    expect(second).toEqual({
      usersCreated: 0,
      rolesGranted: 0,
      alreadyAdmin: 1,
      namesWritten: 0,
    });
  });

  it('updates a changed name, and leaves it alone when the variable drops it', async () => {
    const phone = uniquePhone();

    await seedAdministrators(db, [{ phone, fullName: 'Karimov Anvar' }]);

    const userId = await track(phone);

    const renamed = await seedAdministrators(db, [
      { phone, fullName: 'Karimov Anvar Rustam' },
    ]);

    expect(renamed.namesWritten).toBe(1);

    // Dropping the name from `SEED_ADMIN_PHONES` must not erase one that is already there:
    // an erasure is BR-14's job and goes through `RetentionService`, not through somebody
    // shortening an environment variable.
    const dropped = await seedAdministrators(db, [{ phone, fullName: null }]);

    expect(dropped.namesWritten).toBe(0);

    const user = await db
      .selectFrom('users')
      .select('full_name')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(user.full_name).toBe('Karimov Anvar Rustam');
  });

  it('grants the role to an account that already exists, without touching its name', async () => {
    // The ordinary case on a live instance: the person registered through the app first, so
    // their name is their own and the seeder only adds the entitlement.
    const phone = uniquePhone();

    const created = await db
      .insertInto('users')
      .values({ phone })
      .returning('id')
      .executeTakeFirstOrThrow();

    users.push(created.id);

    const report = await seedAdministrators(db, [{ phone, fullName: null }]);

    expect(report).toEqual({
      usersCreated: 0,
      rolesGranted: 1,
      alreadyAdmin: 0,
      namesWritten: 0,
    });
  });
});

describe('users_purged_has_no_name', () => {
  it('refuses a name on an anonymized row', async () => {
    // BR-14: the identity goes and the id stays. The check is what makes "anonymized but
    // still named" unrepresentable rather than merely unlikely - `RetentionService` clears
    // the column, and this is what catches the day somebody adds a write that does not.
    const phone = uniquePhone();

    const created = await db
      .insertInto('users')
      .values({ phone, full_name: 'Karimov Anvar' })
      .returning('id')
      .executeTakeFirstOrThrow();

    users.push(created.id);

    await db
      .updateTable('users')
      .set({ phone: null, full_name: null, purged_at: new Date() })
      .where('id', '=', created.id)
      .execute();

    await expect(
      db
        .updateTable('users')
        .set({ full_name: 'Karimov Anvar' })
        .where('id', '=', created.id)
        .execute(),
    ).rejects.toThrow(/users_purged_has_no_name/);
  });

  it('leaves a live account free to hold one', async () => {
    const phone = uniquePhone();

    const created = await db
      .insertInto('users')
      .values({ phone, full_name: 'Karimov Anvar' })
      .returning('id')
      .executeTakeFirstOrThrow();

    users.push(created.id);

    const count = await sql<{
      total: string;
    }>`SELECT count(*) AS total FROM users WHERE id = ${created.id} AND full_name IS NOT NULL`.execute(
      db,
    );

    expect(count.rows[0]?.total).toBe('1');
  });
});
