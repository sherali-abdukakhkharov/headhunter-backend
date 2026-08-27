import type { ConfigService } from '@nestjs/config';

import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { EmployersService } from '@modules/employers/employers.service';

import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';

/**
 * §10.5's editable money settings, against a real Postgres.
 *
 * The point of the table is that a price can change **while the API is running**, which
 * is precisely what a unit test with a stubbed database cannot show: the old code read
 * these once in a constructor and every test still passed.
 */

let db: Database;
let destroy: () => Promise<void>;
let pricing: PricingService;
let wallet: WalletService;

const users: string[] = [];

const config = {
  get: (key: string) =>
    key === 'COIN_PRICE_UZS'
      ? 10_000
      : key === 'CANDIDATE_UNLOCK_COINS'
        ? 2
        : key === 'EMPLOYER_REGISTRATION_BONUS_COINS'
          ? 10
          : undefined,
} as unknown as ConfigService<AppEnv, true>;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  pricing = new PricingService(db, config);
  wallet = new WalletService(db, new EmployersService(db), pricing);
});

beforeEach(async () => {
  await db.deleteFrom('platform_settings').execute();
});

afterAll(async () => {
  await db.deleteFrom('platform_settings').execute();

  for (const id of users) {
    // `wallet_transactions` is append-only (BR-24) and `employer_wallets.user_id`
    // is RESTRICT, so an account that has held a wallet or acted on one is left
    // behind on purpose - the same bargain `wallet.int.spec.ts` documents at length.
    // BR-14's answer for such an account is anonymization, not deletion.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    if (held) continue;

    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function newAdmin(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ phone: fixturePhone(), locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  users.push(row.id);

  return row.id;
}

describe('PricingService', () => {
  it('falls back to what the deployment declared when nothing has been set', async () => {
    // An absent row means "nobody has changed this", not "unconfigured" - which is
    // what lets this ship without a data migration and without a fresh deployment
    // behaving differently from the day before.
    await expect(pricing.current()).resolves.toEqual({
      coinPriceUzs: 10_000,
      candidateUnlockCoins: 2,
      registrationBonusCoins: 10,
    });

    expect(pricing.declared()).toEqual(await pricing.current());
  });

  it('writes only the settings it was given', async () => {
    const admin = await newAdmin();

    const applied = await pricing.update(admin, { coinPriceUzs: 12_000 });

    expect(applied).toEqual({ coinPriceUzs: 12_000 });

    const current = await pricing.current();
    expect(current.coinPriceUzs).toBe(12_000);
    // Untouched, and still coming from the environment rather than having been
    // copied into the table - which is what makes a later change of the declared
    // default actually take effect.
    expect(current.candidateUnlockCoins).toBe(2);

    const rows = await db
      .selectFrom('platform_settings')
      .select('key')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('records who changed it', async () => {
    const admin = await newAdmin();
    await pricing.update(admin, { candidateUnlockCoins: 5 });

    const row = await db
      .selectFrom('platform_settings')
      .select(['updated_by_user_id', 'value_int'])
      .where('key', '=', 'candidate_unlock_coins')
      .executeTakeFirstOrThrow();

    expect(row.updated_by_user_id).toBe(admin);
    expect(Number(row.value_int)).toBe(5);
  });

  it('overwrites rather than accumulating rows for one setting', async () => {
    const admin = await newAdmin();

    await pricing.update(admin, { coinPriceUzs: 11_000 });
    await pricing.update(admin, { coinPriceUzs: 13_000 });

    const rows = await db
      .selectFrom('platform_settings')
      .select('value_int')
      .where('key', '=', 'coin_price_uzs')
      .execute();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value_int)).toBe(13_000);
  });

  it('reverts to the declared default when a setting is reset', async () => {
    const admin = await newAdmin();
    await pricing.update(admin, { coinPriceUzs: 25_000 });

    await pricing.reset('coinPriceUzs');

    // Reverting by *deleting* rather than writing the default back: the two differ
    // the next time the deployment changes its mind about the default.
    expect((await pricing.current()).coinPriceUzs).toBe(10_000);
    await expect(
      db
        .selectFrom('platform_settings')
        .select('key')
        .where('key', '=', 'coin_price_uzs')
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it('refuses a free Coin, a free unlock and a negative bonus', async () => {
    const admin = await newAdmin();

    // A free unlock in particular voids BR-16: §6.6 exists to charge for it, and an
    // entitlement that costs nothing is not an entitlement.
    await expect(
      pricing.update(admin, { candidateUnlockCoins: 0 }),
    ).rejects.toThrow(BadRequestError);
    await expect(pricing.update(admin, { coinPriceUzs: 0 })).rejects.toThrow(
      BadRequestError,
    );
    await expect(
      pricing.update(admin, { registrationBonusCoins: -1 }),
    ).rejects.toThrow(BadRequestError);

    // A zero bonus is legitimate - a deployment may simply not give one.
    await expect(
      pricing.update(admin, { registrationBonusCoins: 0 }),
    ).resolves.toEqual({ registrationBonusCoins: 0 });
  });

  it('refuses a fractional value', async () => {
    const admin = await newAdmin();

    // Coins are countable and the price is whole so'm. Rounding silently is how a
    // ledger and a screen end up disagreeing by one.
    await expect(
      pricing.update(admin, { candidateUnlockCoins: 1.5 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('is read per call, so a change reaches a running API', async () => {
    const admin = await newAdmin();

    expect((await wallet.pricing()).coinPriceUzs).toBe(10_000);

    await pricing.update(admin, {
      coinPriceUzs: 20_000,
      candidateUnlockCoins: 3,
    });

    // No restart, no cache invalidation. This is the whole reason the values moved
    // out of WalletService's constructor: read once at boot, a price an
    // administrator changed would be quoted at the old number for hours.
    expect(await wallet.pricing()).toEqual({
      coinPriceUzs: 20_000,
      candidateUnlockCoins: 3,
      candidateUnlockUzs: 60_000,
    });
  });
});
