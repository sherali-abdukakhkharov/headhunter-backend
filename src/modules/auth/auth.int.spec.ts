import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { TooManyRequestsError } from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';

import { EmployersService } from '@modules/employers/employers.service';
import { UsersService } from '@modules/users/users.service';

import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { WalletService } from '@modules/wallet/wallet.service';

import { LoggingSmsSender } from './sms/logging-sms.sender';
import type { SmsResult, SmsSender } from './sms/sms-sender';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Integration tests against a real Postgres.
 *
 * Run with `pnpm test:int`; excluded from `pnpm test`, which stays DB-free.
 *
 * These cannot be unit tests. Attempt lockout, OTP supersession, refresh
 * rotation and reuse detection are all enforced by row locks, partial unique
 * indexes and transaction boundaries - a `DummyDriver` compiles the queries but
 * never runs them, so it would pass while the behaviour was entirely absent.
 */

dotenv.config();

const CONFIG: Partial<AppEnv> = {
  TOKEN_HASH_PEPPER: 'integration-test-pepper-at-least-32-chars',
  JWT_SECRET: 'integration-test-jwt-secret-at-least-32-chars',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  // 0 so a resend in the same test is not refused by the delay; the delay itself
  // has its own test that sets it explicitly.
  OTP_RESEND_DELAY_SECONDS: 0,
  OTP_MAX_ATTEMPTS: 3,
  OTP_ECHO_IN_RESPONSE: true,
  // The Coin economy, because `selectRoles` now grants BR-15's bonus inside its own
  // transaction. The specification's initial values, so a balance assertion here reads
  // the same as one in the wallet suite.
  COIN_PRICE_UZS: 10_000,
  CANDIDATE_UNLOCK_COINS: 2,
  EMPLOYER_REGISTRATION_BONUS_COINS: 10,
};

function configService(overrides: Partial<AppEnv> = {}) {
  const values = { ...CONFIG, ...overrides } as Record<string, unknown>;
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnv, true>;
}

let db: Database;
let pool: Pool;

/** Unique per test run so parallel runs and leftovers cannot collide. */
function testPhone(): string {
  return `+99890${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
}

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

function services(overrides: Partial<AppEnv> = {}, sender?: SmsSender) {
  const config = configService(overrides);
  // The logging sender by default: it reports `failed` with `sms_not_configured`,
  // which `OtpService` treats as "no provider configured" and leaves the code in place
  // - the state every one of these tests has always run in.
  const otp = new OtpService(db, sender ?? new LoggingSmsSender(), config);
  const sessions = new SessionService(db, config);
  // JwtService needs no Nest container: TokenService passes the secret per call.
  const tokens = new TokenService(new JwtService({}), config);
  // The real wallet service: BR-15's bonus is granted in the same transaction as the
  // employer role, so `selectRoles` genuinely writes a ledger row here.
  const auth = new AuthService(
    db,
    sessions,
    tokens,
    new WalletService(db, new EmployersService(db), config),
  );
  const users = new UsersService(db);

  return { otp, sessions, tokens, auth, users };
}

describe('OtpService', () => {
  it('issues a code that verifies once and then cannot be reused', async () => {
    const { otp } = services();
    const phone = testPhone();

    const sent = await otp.send(phone, 'login', null);
    expect(sent.devCode).toMatch(/^\d{6}$/);

    await expect(
      otp.verify(phone, 'login', sent.devCode as string),
    ).resolves.toBeUndefined();

    // Consumed: replaying the same code must fail.
    await expect(
      otp.verify(phone, 'login', sent.devCode as string),
    ).rejects.toMatchObject({ messageKey: 'auth.otp_invalid' });
  });

  it('issues OTP_STATIC_CODE instead of a random code when it is set', async () => {
    const { otp } = services({ OTP_STATIC_CODE: '666666' });
    const phone = testPhone();

    const sent = await otp.send(phone, 'login', null);
    expect(sent.devCode).toBe('666666');

    await expect(otp.verify(phone, 'login', '666666')).resolves.toBeUndefined();
  });

  // The whole justification for putting the backdoor at code generation rather
  // than inside `verify`: nothing else about the flow changes, so removing it
  // cannot break a path that was only ever exercised with it on.
  it('a static code is still single-use and still wrong codes are refused', async () => {
    const { otp } = services({ OTP_STATIC_CODE: '666666' });
    const phone = testPhone();

    await otp.send(phone, 'login', null);

    await expect(otp.verify(phone, 'login', '111111')).rejects.toMatchObject({
      messageKey: 'auth.otp_invalid',
    });

    await expect(otp.verify(phone, 'login', '666666')).resolves.toBeUndefined();

    // Consumed, exactly as a random code would be - the fixed code is not a
    // standing password.
    await expect(otp.verify(phone, 'login', '666666')).rejects.toMatchObject({
      messageKey: 'auth.otp_invalid',
    });
  });

  it('refuses a static code whose length disagrees with OTP_LENGTH', () => {
    expect(() => services({ OTP_STATIC_CODE: '6666' })).toThrow(
      /OTP_STATIC_CODE is 4 digits but OTP_LENGTH is 6/,
    );
  });

  it('supersedes the previous code so only one is ever valid', async () => {
    const { otp } = services();
    const phone = testPhone();

    const first = await otp.send(phone, 'login', null);
    const second = await otp.send(phone, 'login', null);

    // The partial unique index allows one unconsumed code per (phone, purpose),
    // so the first must be dead even though it has not expired.
    await expect(
      otp.verify(phone, 'login', first.devCode as string),
    ).rejects.toMatchObject({ messageKey: 'auth.otp_invalid' });

    await expect(
      otp.verify(phone, 'login', second.devCode as string),
    ).resolves.toBeUndefined();
  });

  it('enforces the resend delay', async () => {
    const { otp } = services({ OTP_RESEND_DELAY_SECONDS: 60 });
    const phone = testPhone();

    await otp.send(phone, 'login', null);
    await expect(otp.send(phone, 'login', null)).rejects.toThrow(
      TooManyRequestsError,
    );
  });

  it('locks the code out after the configured number of wrong attempts', async () => {
    const { otp } = services();
    const phone = testPhone();

    const sent = await otp.send(phone, 'login', null);
    const wrong = sent.devCode === '000000' ? '111111' : '000000';

    // OTP_MAX_ATTEMPTS is 3 here.
    for (let i = 0; i < 3; i += 1) {
      await expect(otp.verify(phone, 'login', wrong)).rejects.toMatchObject({
        messageKey: 'auth.otp_invalid',
      });
    }

    await expect(otp.verify(phone, 'login', wrong)).rejects.toThrow(
      TooManyRequestsError,
    );

    // Locked out means the *correct* code is dead too - otherwise the limit only
    // slows an attacker down rather than stopping them.
    await expect(
      otp.verify(phone, 'login', sent.devCode as string),
    ).rejects.toThrow();
  });

  it('rejects an expired code', async () => {
    const { otp } = services({ OTP_TTL_SECONDS: 30 });
    const phone = testPhone();

    const sent = await otp.send(phone, 'login', null);

    // Age the row rather than waiting, and with the database clock: `verify`
    // compares against `now()`, so a `Date.now()` value only holds while the two
    // clocks agree.
    await db
      .updateTable('otp_codes')
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where('phone', '=', phone)
      .execute();

    await expect(
      otp.verify(phone, 'login', sent.devCode as string),
    ).rejects.toMatchObject({ messageKey: 'auth.otp_invalid' });
  });

  it('never stores the code itself', async () => {
    const { otp } = services();
    const phone = testPhone();

    const sent = await otp.send(phone, 'login', null);

    const row = await db
      .selectFrom('otp_codes')
      .select('code_hash')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    expect(row.code_hash).not.toContain(sent.devCode as string);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('AuthService registration and login', () => {
  it('creates the account on first verification and reuses it afterwards', async () => {
    const { auth } = services();
    const phone = testPhone();

    const first = await auth.completePhoneVerification(phone, 'ru', {});
    expect(first.isNewUser).toBe(true);
    expect(first.roles).toEqual([]);
    expect(first.activeRole).toBeNull();

    const second = await auth.completePhoneVerification(phone, 'ru', {});
    expect(second.isNewUser).toBe(false);

    const users = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .execute();

    expect(users).toHaveLength(1);
  });

  it('writes the opening status-history row at registration (BR-08)', async () => {
    const { auth } = services();
    const phone = testPhone();

    await auth.completePhoneVerification(phone, 'en', {});

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status', 'reason'])
      .where('user_id', '=', user.id)
      .execute();

    expect(history).toEqual([
      { from_status: null, to_status: 'active', reason: 'registration' },
    ]);
  });

  it('refuses a blocked account at login, not merely at mutation (BR-10)', async () => {
    const { auth } = services();
    const phone = testPhone();

    await auth.completePhoneVerification(phone, 'en', {});
    await db
      .updateTable('users')
      .set({ status: 'blocked' })
      .where('phone', '=', phone)
      .execute();

    await expect(
      auth.completePhoneVerification(phone, 'en', {}),
    ).rejects.toMatchObject({ messageKey: 'account.blocked' });
  });

  it('refuses to self-assign the admin role', async () => {
    const { auth } = services();
    const phone = testPhone();

    const tokens = await auth.completePhoneVerification(phone, 'en', {});
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    void tokens;

    await expect(auth.selectRoles(user.id, ['admin'])).rejects.toMatchObject({
      messageKey: 'role.admin_not_self_assignable',
    });

    const roles = await db
      .selectFrom('user_roles')
      .select('role')
      .where('user_id', '=', user.id)
      .execute();

    expect(roles).toEqual([]);
  });

  it('is idempotent when onboarding re-sends the same roles', async () => {
    const { auth } = services();
    const phone = testPhone();

    await auth.completePhoneVerification(phone, 'en', {});
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await auth.selectRoles(user.id, ['candidate']);
    const roles = await auth.selectRoles(user.id, ['candidate', 'employer']);

    expect([...roles].sort()).toEqual(['candidate', 'employer']);
  });

  it('refuses switching to a role the account does not hold', async () => {
    const { auth, sessions } = services();
    const phone = testPhone();

    await auth.completePhoneVerification(phone, 'en', {});
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await auth.selectRoles(user.id, ['candidate']);
    const session = await sessions.issue(user.id, {});

    await expect(
      auth.switchActiveRole(user.id, session.sessionId, 'employer'),
    ).rejects.toMatchObject({ messageKey: 'role.not_granted' });

    await expect(
      auth.switchActiveRole(user.id, session.sessionId, 'candidate'),
    ).resolves.toMatchObject({ expiresInSeconds: 900 });
  });

  it('moves the account to deletion_requested with an audit row', async () => {
    const { auth, users } = services();
    const phone = testPhone();

    await auth.completePhoneVerification(phone, 'en', {});
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await users.requestDeletion(user.id, 'no longer looking');
    // Second call must not create a second open request (partial unique index).
    await users.requestDeletion(user.id, 'no longer looking');

    const requests = await db
      .selectFrom('deletion_requests')
      .select(['id', 'purge_after'])
      .where('user_id', '=', user.id)
      .execute();

    expect(requests).toHaveLength(1);
    // BR-14 retention is unanswered, so no purge date is invented.
    expect(requests[0].purge_after).toBeNull();

    const status = await db
      .selectFrom('users')
      .select('status')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();

    expect(status.status).toBe('deletion_requested');

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status'])
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .execute();

    expect(history).toEqual([
      { from_status: null, to_status: 'active' },
      { from_status: 'active', to_status: 'deletion_requested' },
    ]);
  });
});

describe('SessionService refresh rotation', () => {
  /**
   * A user with **no** sessions.
   *
   * `completePhoneVerification` opens one, so it is revoked here: these tests
   * assert on exact family membership and live-session counts, and a stray
   * registration session silently makes those assertions meaningless.
   */
  async function newUser(): Promise<string> {
    const { auth, sessions } = services();
    const phone = testPhone();
    await auth.completePhoneVerification(phone, 'en', {});

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await sessions.revokeAllForUser(user.id, 'test_setup');
    await db.deleteFrom('sessions').where('user_id', '=', user.id).execute();

    return user.id;
  }

  it('rotates a refresh token and revokes the presented one', async () => {
    const { sessions } = services();
    const userId = await newUser();

    const first = await sessions.issue(userId, { name: 'Pixel 8' });
    const rotated = await sessions.rotate(first.refreshToken, {});

    expect(rotated.userId).toBe(userId);
    expect(rotated.session.refreshToken).not.toBe(first.refreshToken);

    const old = await db
      .selectFrom('sessions')
      .select(['revoked_at', 'revoked_reason', 'replaced_by_session_id'])
      .where('id', '=', first.sessionId)
      .executeTakeFirstOrThrow();

    expect(old.revoked_at).not.toBeNull();
    expect(old.revoked_reason).toBe('rotated');
    expect(old.replaced_by_session_id).toBe(rotated.session.sessionId);
  });

  it('keeps the rotated session in the same family', async () => {
    const { sessions } = services();
    const userId = await newUser();

    const first = await sessions.issue(userId, {});
    const rotated = await sessions.rotate(first.refreshToken, {});

    const rows = await db
      .selectFrom('sessions')
      .select(['id', 'family_id'])
      .where('user_id', '=', userId)
      .execute();

    expect(new Set(rows.map((r) => r.family_id)).size).toBe(1);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [first.sessionId, rotated.session.sessionId].sort(),
    );
  });

  it('revokes the whole family when a used token is presented again', async () => {
    const { sessions } = services();
    const userId = await newUser();

    const first = await sessions.issue(userId, {});
    const second = await sessions.rotate(first.refreshToken, {});
    const third = await sessions.rotate(second.session.refreshToken, {});

    // Replay of the first token: either a stolen token or a client without
    // single-flight refresh. Both must invalidate the family.
    await expect(sessions.rotate(first.refreshToken, {})).rejects.toMatchObject(
      { messageKey: 'auth.refresh_reused' },
    );

    const live = await db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();

    expect(live).toEqual([]);

    // The newest token is dead too - that is the point of family revocation.
    await expect(
      sessions.rotate(third.session.refreshToken, {}),
    ).rejects.toThrow();
  });

  it('serializes two concurrent rotations of the same token into one winner', async () => {
    const { sessions } = services();
    const userId = await newUser();

    const first = await sessions.issue(userId, {});

    const results = await Promise.allSettled([
      sessions.rotate(first.refreshToken, {}),
      sessions.rotate(first.refreshToken, {}),
    ]);

    // The row lock means one transaction rotates and the other then sees a
    // revoked row. Exactly one succeeds; the loser trips reuse detection.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('rejects an unknown or expired refresh token', async () => {
    const { sessions } = services();
    const userId = await newUser();

    await expect(sessions.rotate('not-a-real-token', {})).rejects.toMatchObject(
      { messageKey: 'auth.refresh_invalid' },
    );

    const session = await sessions.issue(userId, {});
    await db
      .updateTable('sessions')
      // Aged with the *database* clock, deliberately. `rotate` decides expiry
      // with `now()`, so a value derived from `Date.now()` only works while the
      // two clocks agree - and this is a container, so they drift. A one-second
      // margin against the wrong clock is a test that fails on a slow morning.
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where('id', '=', session.sessionId)
      .execute();

    await expect(
      sessions.rotate(session.refreshToken, {}),
    ).rejects.toMatchObject({ messageKey: 'auth.refresh_expired' });
  });

  it('never stores the refresh token itself', async () => {
    const { sessions } = services();
    const userId = await newUser();

    const session = await sessions.issue(userId, {});
    const row = await db
      .selectFrom('sessions')
      .select('refresh_token_hash')
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();

    expect(row.refresh_token_hash).not.toBe(session.refreshToken);
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SessionService revocation', () => {
  /** Exactly two live sessions - the registration one is cleared first. */
  async function userWithTwoSessions() {
    const { auth, sessions } = services();
    const phone = testPhone();
    await auth.completePhoneVerification(phone, 'en', {});

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await db.deleteFrom('sessions').where('user_id', '=', user.id).execute();

    const a = await sessions.issue(user.id, { name: 'Phone' });
    const b = await sessions.issue(user.id, { name: 'Tablet' });

    return { sessions, userId: user.id, a, b };
  }

  it('lists only active sessions, newest use first', async () => {
    const { sessions, userId, a } = await userWithTwoSessions();

    await sessions.revokeById(userId, a.sessionId);
    const active = await sessions.listActive(userId);

    expect(active.map((s) => s.id)).not.toContain(a.sessionId);
    expect(active).toHaveLength(1);
  });

  it('refuses to revoke a session belonging to someone else', async () => {
    const first = await userWithTwoSessions();
    const second = await userWithTwoSessions();

    // Ownership is in the UPDATE predicate, so this is a no-op rather than a
    // cross-account revocation.
    const revoked = await first.sessions.revokeById(
      first.userId,
      second.a.sessionId,
    );

    expect(revoked).toBe(false);
    expect(await second.sessions.isActive(second.a.sessionId)).toBe(true);
  });

  it('revoke-all kills every session for the account', async () => {
    const { sessions, userId, a, b } = await userWithTwoSessions();

    const count = await sessions.revokeAllForUser(userId, 'logout_all');

    expect(count).toBe(2);
    expect(await sessions.isActive(a.sessionId)).toBe(false);
    expect(await sessions.isActive(b.sessionId)).toBe(false);
  });

  it('logout by token is idempotent', async () => {
    const { sessions, a } = await userWithTwoSessions();

    await sessions.revokeByToken(a.refreshToken);
    await expect(
      sessions.revokeByToken(a.refreshToken),
    ).resolves.toBeUndefined();

    expect(await sessions.isActive(a.sessionId)).toBe(false);
  });

  it('reports an unknown session id as inactive rather than throwing', async () => {
    const { sessions } = services();
    expect(await sessions.isActive(randomUUID())).toBe(false);
  });
});

describe('TokenService', () => {
  it('round-trips claims', async () => {
    const { tokens } = services();

    const token = await tokens.signAccessToken({
      sub: 'user-1',
      roles: ['candidate', 'employer'],
      activeRole: 'employer',
      sid: 'session-1',
    });

    const claims = await tokens.verifyAccessToken(token);

    expect(claims.sub).toBe('user-1');
    expect(claims.roles).toEqual(['candidate', 'employer']);
    expect(claims.activeRole).toBe('employer');
    expect(claims.sid).toBe('session-1');
  });

  it('rejects a token signed with a different secret', async () => {
    const mine = services().tokens;
    const theirs = services({
      JWT_SECRET: 'a-completely-different-secret-32-chars-long',
    }).tokens;

    const forged = await theirs.signAccessToken({
      sub: 'user-1',
      roles: ['admin'],
      activeRole: 'admin',
      sid: 'session-1',
    });

    await expect(mine.verifyAccessToken(forged)).rejects.toMatchObject({
      messageKey: 'auth.token_invalid',
    });
  });

  it('rejects an expired token', async () => {
    const { tokens } = services({ ACCESS_TOKEN_TTL_SECONDS: 60 });

    const token = await tokens.signAccessToken({
      sub: 'user-1',
      roles: ['candidate'],
      activeRole: 'candidate',
      sid: 'session-1',
    });

    // Rewind rather than wait: jsonwebtoken checks exp against Date.now().
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      await expect(tokens.verifyAccessToken(token)).rejects.toThrow();
    } finally {
      Date.now = realNow;
    }
  });
});

/**
 * OTP delivery (§4.1, docs/SMS_PROVIDER.md).
 *
 * These need a real database because the thing being asserted is what is *left in the
 * table* after a send that failed - and the resend delay is evaluated in SQL against the
 * rows that remain.
 */
describe('OTP delivery', () => {
  /** A sender that reports whatever it is told to, without touching a network. */
  function sender(result: SmsResult): SmsSender {
    return { send: () => Promise.resolve(result) };
  }

  it('sends the code, in the language the client asked in', async () => {
    const sent: { text: string; locale: string }[] = [];
    const recording: SmsSender = {
      send: (message) => {
        sent.push({ text: message.text, locale: message.locale });

        return Promise.resolve({ status: 'sent' as const });
      },
    };

    const { otp } = services({ OTP_STATIC_CODE: '424242' }, recording);
    await otp.send(testPhone(), 'login', null, 'ru');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.locale).toBe('ru');
    // The code is in the message and the message is Russian - the one screen where the
    // recipient has no account whose locale could be read instead.
    expect(sent[0]?.text).toContain('424242');
    expect(sent[0]?.text).toMatch(/[А-Яа-я]/);
  });

  it('removes the code when delivery fails, so the user can retry at once', async () => {
    const phone = testPhone();
    const { otp } = services(
      { OTP_RESEND_DELAY_SECONDS: 60 },
      sender({ status: 'failed', error: 'sms_rejected_500' }),
    );

    await expect(otp.send(phone, 'login', null)).rejects.toMatchObject({
      messageKey: 'auth.otp_send_failed',
    });

    // Nothing was delivered, so nothing should be live: a code the user never received
    // must not occupy the one-live-code slot.
    const rows = await db
      .selectFrom('otp_codes')
      .select('id')
      .where('phone', '=', phone)
      .where('consumed_at', 'is', null)
      .execute();
    expect(rows).toEqual([]);

    // And - the part that would have been found in production - the resend delay is
    // measured from the most recent row whatever its state, so leaving it behind would
    // lock the user out for a minute over a message that never arrived.
    const retried = await services(
      { OTP_RESEND_DELAY_SECONDS: 60, OTP_ECHO_IN_RESPONSE: true },
      sender({ status: 'sent' }),
    ).otp.send(phone, 'login', null);

    expect(retried.devCode).toMatch(/^\d{6}$/);
  });

  it('keeps the code when no provider is configured at all', async () => {
    const phone = testPhone();
    const { otp } = services(
      { OTP_STATIC_CODE: '666666' },
      new LoggingSmsSender(),
    );

    // The development and test path: the logging sender reports `failed`, and it must
    // not be mistaken for a provider that failed - deleting the row here would break
    // every login on an instance with no Eskiz account.
    await expect(otp.send(phone, 'login', null)).resolves.toMatchObject({
      devCode: '666666',
    });
    await expect(otp.verify(phone, 'login', '666666')).resolves.toBeUndefined();
  });

  it('does not send at all when the send itself was refused', async () => {
    const phone = testPhone();
    let calls = 0;
    const counting: SmsSender = {
      send: () => {
        calls += 1;

        return Promise.resolve({ status: 'sent' as const });
      },
    };

    const { otp } = services({ OTP_RESEND_DELAY_SECONDS: 3600 }, counting);
    await otp.send(phone, 'login', null);

    // The resend delay refuses this inside the transaction, before a code exists. An
    // SMS sent here would be a message with no code behind it.
    await expect(otp.send(phone, 'login', null)).rejects.toMatchObject({
      messageKey: 'auth.otp_resend_too_soon',
    });
    expect(calls).toBe(1);
  });
});

/**
 * BR-15's bonus, at the point it is actually granted.
 *
 * The wallet suite tests `grantRegistrationBonus` directly; this tests the integration
 * that matters - that choosing the employer role during onboarding credits the Coins, in
 * the same transaction, so an employer without a wallet cannot exist.
 */
describe('the employer registration bonus (BR-15, UAT-16)', () => {
  it('creates the wallet and credits ten Coins on first employer registration', async () => {
    const { auth, otp } = services();
    const phone = testPhone();
    const sent = await otp.send(phone, 'registration', null);
    await otp.verify(phone, 'registration', sent.devCode as string);
    const tokens = await auth.completePhoneVerification(phone, 'uz-Latn', {});

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    expect(tokens.roles).toEqual([]);

    await auth.selectRoles(user.id, ['employer']);

    const wallet = await db
      .selectFrom('employer_wallets')
      .select(['balance_coins', 'registration_bonus_at'])
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();

    expect(wallet.balance_coins).toBe(10);
    expect(wallet.registration_bonus_at).toBeInstanceOf(Date);

    // **This user is deliberately left behind.** The wallet ledger is append-only
    // (BR-24) and `employer_wallets` now references `users` with RESTRICT, so an
    // employer who has ever held a Coin cannot be deleted at all - not by a purge, and
    // not by this test. BR-14's answer is to anonymize them, which
    // `retention.int.spec.ts` covers. Finding that here rather than in production is
    // the constraint working.
  });

  it('does not credit a candidate, and credits once when the role is added later', async () => {
    const { auth, otp } = services();
    const phone = testPhone();
    const sent = await otp.send(phone, 'registration', null);
    await otp.verify(phone, 'registration', sent.devCode as string);
    await auth.completePhoneVerification(phone, 'uz-Latn', {});

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    await auth.selectRoles(user.id, ['candidate']);

    // A candidate has no wallet at all: Coins are employer functionality (BR-21).
    expect(
      await db
        .selectFrom('employer_wallets')
        .select('user_id')
        .where('user_id', '=', user.id)
        .executeTakeFirst(),
    ).toBeUndefined();

    // §2.3's multi-role account adding the employer side later still gets the bonus, and
    // re-sending the roles - which onboarding does on a retry - must not grant a second.
    await auth.selectRoles(user.id, ['candidate', 'employer']);
    await auth.selectRoles(user.id, ['candidate', 'employer']);

    expect(
      (
        await db
          .selectFrom('employer_wallets')
          .select('balance_coins')
          .where('user_id', '=', user.id)
          .executeTakeFirstOrThrow()
      ).balance_coins,
    ).toBe(10);

    // Left behind for the same reason as above: this account now has financial history.
  });
});
