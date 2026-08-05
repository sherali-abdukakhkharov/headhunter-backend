import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';

import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { TelegramOidcService } from './telegram-oidc.service';
import { TokenService } from './token.service';

/**
 * Telegram login, end to end below the HTTP layer.
 *
 * The tokens are **really signed and really verified**: the spec generates an RSA
 * keypair, serves the public half from a local JWKS endpoint, and points the service
 * at it. Nothing about `jose`, key selection by `kid`, the audience check or the
 * `iat` window is stubbed, because those checks *are* the security of this flow -
 * a mocked verifier would assert that the mock was called.
 *
 * A real Postgres, because the interesting part of the service is the three-way
 * find / link / create decision and the audit rows it writes.
 */

const ISSUER = 'https://oauth.telegram.org';
const BOT_ID = '7654321';

let db: Database;
let destroy: () => Promise<void>;
let jwksServer: Server;
let jwksUrl: string;
let signingKey: CryptoKey;
/** A key that is *not* in the served JWKS, for the forged-token case. */
let foreignKey: CryptoKey;

const CONFIG: Partial<AppEnv> = {
  TOKEN_HASH_PEPPER: 'integration-test-pepper-at-least-32-chars',
  JWT_SECRET: 'integration-test-jwt-secret-at-least-32-chars',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  TELEGRAM_OIDC_ISSUER: ISSUER,
  TELEGRAM_LOGIN_BOT_ID: BOT_ID,
  TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS: 300,
  TELEGRAM_REQUIRE_PHONE: true,
  // Same bot as login, so the boot-time consistency check stays quiet.
  TELEGRAM_BOT_TOKEN: `${BOT_ID}:AAHtest-not-a-real-bot-token-000000000`,
};

function configService(overrides: Partial<AppEnv> = {}) {
  const values = {
    ...CONFIG,
    TELEGRAM_JWKS_URL: jwksUrl,
    ...overrides,
  } as Record<string, unknown>;

  return { get: (key: string) => values[key] } as unknown as ConfigService<
    AppEnv,
    true
  >;
}

function services(overrides: Partial<AppEnv> = {}) {
  const config = configService(overrides);
  const sessions = new SessionService(db, config);
  const tokens = new TokenService(new JwtService({}), config);

  return {
    auth: new AuthService(db, sessions, tokens),
    telegram: new TelegramOidcService(config),
    sessions,
  };
}

interface TokenOptions {
  sub?: string;
  audience?: string;
  issuer?: string;
  phone?: string | null;
  phoneVerified?: boolean;
  /** Emit `phone_number` with no `phone_number_verified` - what Telegram sends. */
  omitVerifiedClaim?: boolean;
  username?: string | null;
  issuedAt?: number;
  expiresAt?: number;
  nonce?: string;
  signWith?: CryptoKey;
  kid?: string;
}

/** Mints a token exactly as Telegram's authorization server would. */
async function idToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.issuedAt ?? now;

  // Exactly the claims Telegram's discovery document advertises - `name`,
  // `preferred_username`, `picture`, plus `sub`/`aud`/`iss`/`iat`/`exp` set below.
  // Deliberately no `id`, `given_name` or `family_name`: the prose docs mention them
  // but `claims_supported` does not list them, so nothing may depend on them.
  const claims: Record<string, unknown> = {
    name: 'Alisher Karimov',
    preferred_username: options.username ?? 'alisher_k',
    picture: 'https://t.me/i/userpic/320/alisher_k.jpg',
  };

  const phone = options.phone === undefined ? '+998901234567' : options.phone;

  if (phone !== null) {
    claims.phone_number = phone;

    if (!options.omitVerifiedClaim) {
      claims.phone_number_verified = options.phoneVerified ?? true;
    }
  }

  if (options.nonce) {
    claims.nonce = options.nonce;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'test-key-1' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? BOT_ID)
    .setSubject(options.sub ?? '111222333')
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expiresAt ?? issuedAt + 3600)
    .sign(options.signWith ?? signingKey);
}

/** A Telegram user id no other test in this run will use. */
function telegramId(): string {
  return String(500_000_000 + Math.floor(Math.random() * 100_000_000));
}

function testPhone(): string {
  return `+99894${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
}

beforeAll(async () => {
  ({ db, destroy } = createIntTestDb());

  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);

  const foreignPair = await generateKeyPair('RS256');
  foreignKey = foreignPair.privateKey;

  // Serves only the real key, so a token signed with `foreignKey` cannot verify -
  // which is the whole point of fetching keys rather than trusting the token.
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        keys: [{ ...publicJwk, kid: 'test-key-1', alg: 'RS256', use: 'sig' }],
      }),
    );
  });

  await new Promise<void>((resolve) => {
    jwksServer.listen(0, '127.0.0.1', resolve);
  });

  const { port } = jwksServer.address() as AddressInfo;
  // `jose` requires https for a remote key set only in the browser; on Node an
  // http URL to localhost is accepted, which keeps this spec self-contained.
  jwksUrl = `http://127.0.0.1:${port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  await destroy();
});

describe('id_token verification', () => {
  it('accepts a properly signed token and extracts the identity', async () => {
    const { telegram } = services();
    const sub = telegramId();

    const identity = await telegram.verify(
      await idToken({ sub, phone: '+998901112233', username: 'alisher_k' }),
    );

    expect(identity).toEqual({
      telegramUserId: sub,
      username: 'alisher_k',
      verifiedPhone: '+998901112233',
      displayName: 'Alisher Karimov',
    });
  });

  it('refuses a token signed by a key that is not in the JWKS', async () => {
    const { telegram } = services();

    // The forged-token case: anyone can mint a JWT, but only Telegram can sign one
    // with a key Telegram publishes.
    await expect(
      telegram.verify(await idToken({ signWith: foreignKey })),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });

  it('refuses a token addressed to a different bot', async () => {
    const { telegram } = services();

    // Token substitution: a genuine Telegram token issued for somebody else's
    // application. Real, correctly signed, and must still be refused - this check is
    // the only thing standing between us and every other Telegram login on earth.
    await expect(
      telegram.verify(await idToken({ audience: '1234567' })),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });

  it('refuses a token from a different issuer', async () => {
    const { telegram } = services();

    await expect(
      telegram.verify(await idToken({ issuer: 'https://evil.example.com' })),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });

  it('refuses an expired token', async () => {
    const { telegram } = services();
    const now = Math.floor(Date.now() / 1000);

    await expect(
      telegram.verify(
        await idToken({ issuedAt: now - 7200, expiresAt: now - 3600 }),
      ),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });

  it('refuses a token older than the age window even while exp is in the future', async () => {
    const { telegram } = services();
    const now = Math.floor(Date.now() / 1000);

    // The replay case. `exp` is an hour away, so `exp` alone would accept this -
    // `maxTokenAge` is what closes the window.
    const stale = await idToken({
      issuedAt: now - 1800,
      expiresAt: now + 3600,
    });

    await expect(telegram.verify(stale)).rejects.toMatchObject({
      messageKey: 'auth.telegram_token_invalid',
    });

    // ...and the same token is fine for a deployment that allows an older one, which
    // proves the rejection came from the age check and not from something else.
    const lenient = services({ TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS: 3600 });
    await expect(lenient.telegram.verify(stale)).resolves.toMatchObject({
      username: 'alisher_k',
    });
  });

  it('refuses a token whose kid is not published', async () => {
    const { telegram } = services();

    await expect(
      telegram.verify(await idToken({ kid: 'not-a-real-kid' })),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });

  it('refuses garbage that is not a JWT at all', async () => {
    const { telegram } = services();

    await expect(telegram.verify('not.a.jwt')).rejects.toMatchObject({
      messageKey: 'auth.telegram_token_invalid',
    });
  });

  it('verifies the nonce when one is expected', async () => {
    const { telegram } = services();

    await expect(
      telegram.verify(await idToken({ nonce: 'abc' }), 'abc'),
    ).resolves.toMatchObject({ username: 'alisher_k' });

    await expect(
      telegram.verify(await idToken({ nonce: 'abc' }), 'different'),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_token_invalid' });
  });
});

describe('the phone number', () => {
  it('accepts a phone_number with no phone_number_verified claim', async () => {
    // The shape Telegram actually sends. Its live discovery document advertises
    // `claims_supported` as `aud preferred_username phone_number exp iat iss name
    // picture sub` - there is no `phone_number_verified`, so requiring one refuses
    // every real login. A Telegram account is a verified phone number by
    // construction, which is what makes the absence safe to treat as verified.
    const { telegram } = services();

    const identity = await telegram.verify(
      await idToken({ phone: '+998901112233', omitVerifiedClaim: true }),
    );

    expect(identity.verifiedPhone).toBe('+998901112233');
  });

  it('honours an explicit phone_number_verified: false', async () => {
    const lenient = services({ TELEGRAM_REQUIRE_PHONE: false });

    // Telegram is not known to emit this, but if it ever does the value must not
    // reach the account-linking step: matching on an unverified number would let
    // anyone claim an existing account by naming its phone.
    const identity = await lenient.telegram.verify(
      await idToken({ phone: '+998900000001', phoneVerified: false }),
    );

    expect(identity.verifiedPhone).toBeNull();
  });

  it('refuses a login with no phone while the phone scope is required', async () => {
    const { telegram } = services();

    await expect(
      telegram.verify(await idToken({ phone: null })),
    ).rejects.toMatchObject({ messageKey: 'auth.telegram_phone_required' });
  });

  it('allows a login with no phone when the deployment permits it', async () => {
    const lenient = services({ TELEGRAM_REQUIRE_PHONE: false });

    await expect(
      lenient.telegram.verify(await idToken({ phone: null })),
    ).resolves.toMatchObject({ verifiedPhone: null });
  });
});

describe('accounts', () => {
  async function login(
    options: TokenOptions = {},
    overrides: Partial<AppEnv> = {},
  ) {
    const { auth, telegram } = services(overrides);
    const identity = await telegram.verify(await idToken(options));

    return {
      identity,
      tokens: await auth.completeTelegramLogin(identity, 'ru', {}),
    };
  }

  async function userByTelegramId(sub: string) {
    return db
      .selectFrom('users')
      .select([
        'id',
        'phone',
        'telegram_user_id',
        'telegram_username',
        'locale',
        'status',
      ])
      .where('telegram_user_id', '=', sub)
      .executeTakeFirstOrThrow();
  }

  it('creates the account on first login and reuses it afterwards', async () => {
    const sub = telegramId();
    const phone = testPhone();

    const first = await login({ sub, phone });
    expect(first.tokens.isNewUser).toBe(true);
    expect(first.tokens.roles).toEqual([]);
    expect(first.tokens.activeRole).toBeNull();

    const second = await login({ sub, phone });
    expect(second.tokens.isNewUser).toBe(false);

    const rows = await db
      .selectFrom('users')
      .select('id')
      .where('telegram_user_id', '=', sub)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('stores the Telegram id, username and verified phone', async () => {
    const sub = telegramId();
    const phone = testPhone();

    await login({ sub, phone, username: 'candidate_uz' });
    const user = await userByTelegramId(sub);

    expect(user.telegram_user_id).toBe(sub);
    expect(user.telegram_username).toBe('candidate_uz');
    expect(user.phone).toBe(phone);
    expect(user.locale).toBe('ru');
  });

  it('writes the opening status-history row at registration (BR-08)', async () => {
    const sub = telegramId();
    await login({ sub, phone: testPhone() });
    const user = await userByTelegramId(sub);

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status', 'reason'])
      .where('user_id', '=', user.id)
      .execute();

    expect(history).toEqual([
      {
        from_status: null,
        to_status: 'active',
        reason: 'registration_telegram',
      },
    ]);
  });

  it('links to an existing account that has the same verified phone', async () => {
    // The migration case: an account exists from the OTP flow, and its owner now
    // signs in with Telegram. It must be claimed, not duplicated.
    const phone = testPhone();
    const existing = await db
      .insertInto('users')
      .values({ phone, locale: 'uz-Latn' })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('user_roles')
      .values({ user_id: existing.id, role: 'candidate' })
      .execute();

    const sub = telegramId();
    const { tokens } = await login({ sub, phone });

    expect(tokens.isNewUser).toBe(false);
    // The pre-existing role came along, which is the point of linking.
    expect(tokens.roles).toEqual(['candidate']);

    const user = await userByTelegramId(sub);
    expect(user.id).toBe(existing.id);

    const all = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .execute();

    expect(all).toHaveLength(1);
  });

  it('records the link in the account history (BR-08)', async () => {
    const phone = testPhone();
    const existing = await db
      .insertInto('users')
      .values({ phone, locale: 'uz-Latn' })
      .returning('id')
      .executeTakeFirstOrThrow();

    await login({ sub: telegramId(), phone });

    const history = await db
      .selectFrom('account_status_history')
      .select('reason')
      .where('user_id', '=', existing.id)
      .execute();

    // Attaching a second credential is a security-relevant change even though the
    // status did not move, so it leaves a trail.
    expect(history).toEqual([{ reason: 'telegram_account_linked' }]);
  });

  it('never takes over an account already claimed by another Telegram user', async () => {
    const phone = testPhone();
    const owner = telegramId();
    await login({ sub: owner, phone });

    // A second Telegram account presenting the same verified phone. Telegram should
    // not issue that, but if it ever did - a recycled number, say - the existing
    // account must not change hands.
    const intruder = telegramId();
    const { tokens } = await login({ sub: intruder, phone });

    expect(tokens.isNewUser).toBe(true);

    const ownerRow = await userByTelegramId(owner);
    expect(ownerRow.phone).toBe(phone);

    const intruderRow = await userByTelegramId(intruder);
    expect(intruderRow.id).not.toBe(ownerRow.id);
    // The phone stayed with the account that already held it.
    expect(intruderRow.phone).toBeNull();
  });

  it('fills in a missing phone on a later login, and never overwrites one', async () => {
    const sub = telegramId();
    const lenient = { TELEGRAM_REQUIRE_PHONE: false };

    await login({ sub, phone: null }, lenient);
    expect((await userByTelegramId(sub)).phone).toBeNull();

    const granted = testPhone();
    await login({ sub, phone: granted }, lenient);
    expect((await userByTelegramId(sub)).phone).toBe(granted);

    // A different number on a later login does not move the identity: other records
    // and BR-09's contact rule already point at the first one.
    await login({ sub, phone: testPhone() }, lenient);
    expect((await userByTelegramId(sub)).phone).toBe(granted);
  });

  it('refuses a blocked account at login, not merely at mutation (BR-10)', async () => {
    const sub = telegramId();
    await login({ sub, phone: testPhone() });

    await db
      .updateTable('users')
      .set({ status: 'blocked' })
      .where('telegram_user_id', '=', sub)
      .execute();

    await expect(login({ sub, phone: testPhone() })).rejects.toMatchObject({
      messageKey: 'account.blocked',
    });
  });

  it('refuses linking into a blocked account', async () => {
    const phone = testPhone();
    await db
      .insertInto('users')
      .values({ phone, locale: 'uz-Latn', status: 'blocked' })
      .execute();

    await expect(login({ sub: telegramId(), phone })).rejects.toMatchObject({
      messageKey: 'account.blocked',
    });
  });

  it('opens a session the guard will accept', async () => {
    const { sessions } = services();
    const sub = telegramId();
    const { tokens } = await login({ sub, phone: testPhone() });

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();

    const user = await userByTelegramId(sub);
    const active = await sessions.listActive(user.id);
    expect(active).toHaveLength(1);
  });
});

describe('the boot-time configuration check', () => {
  it('stays quiet when the login bot is the file-storage bot', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      services().telegram.onApplicationBootstrap();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the login bot id is not the bot behind the token', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      // The misconfiguration this exists for: every login would fail the audience
      // check and report only `auth.telegram_token_invalid`, which looks exactly
      // like a forged token.
      services({
        TELEGRAM_BOT_TOKEN: '999999:AAHdifferent-bot-000000000000000000',
      }).telegram.onApplicationBootstrap();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('is not the bot behind') as string,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not fail to construct when no bot token is configured', () => {
    // A diagnostic must never be the reason a process cannot start.
    expect(() =>
      services({
        TELEGRAM_BOT_TOKEN: undefined,
      }).telegram.onApplicationBootstrap(),
    ).not.toThrow();
  });
});

describe('the credential constraint', () => {
  it('refuses a user row with neither a phone nor a Telegram id', async () => {
    // Such a row is unreachable by every login path - nobody could ever sign into
    // it again - so the database will not hold one.
    await expect(
      db.insertInto('users').values({ locale: 'ru' }).execute(),
    ).rejects.toThrow(/users_has_a_credential/);
  });
});
