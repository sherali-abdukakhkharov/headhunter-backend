import type { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { EmployersService } from '@modules/employers/employers.service';

import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';

/**
 * The Coin wallet against a real Postgres (§6.6, §12.3.1).
 *
 * Every guarantee this milestone makes is a database guarantee, so almost nothing here
 * could be a unit test: the pair primary key behind BR-16, the partial unique index behind
 * BR-15, the append-only triggers behind BR-24, and a row lock serializing the balance
 * arithmetic. Over `DummyDriver` all of it would compile, run nothing, and pass.
 *
 * The tests that matter most fire two operations **concurrently**. A wallet is the one
 * place in this product where losing a race costs somebody money.
 */

let db: Database;
let destroy: () => Promise<void>;
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
  wallet = new WalletService(
    db,
    new EmployersService(db),
    new PricingService(db, config),
  );
});

afterAll(async () => {
  for (const id of users) {
    // `candidate_unlocks.candidate_user_id` is RESTRICT on purpose - an employer paid for
    // that row - so the unlocks go before the users they point at.
    await db
      .deleteFrom('candidate_unlocks')
      .where((eb) =>
        eb.or([
          eb('employer_user_id', '=', id),
          eb('candidate_user_id', '=', id),
        ]),
      )
      .execute();
  }

  for (const id of users) {
    // **An employer who has held a wallet is left behind, and that is the design.**
    // `employer_wallets.user_id` is `ON DELETE RESTRICT` (migration 20) because §6.7
    // requires payment records to survive for reconciliation and BR-24 forbids rewriting
    // the ledger, so this delete would be refused - by the same constraint, for the same
    // reason, as the administrators `admin.int.spec.ts` leaves behind. BR-14's answer is to
    // anonymize such an account rather than delete it, which `RetentionService` does.
    //
    // The administrators the fixtures use are held by the *second* RESTRICT on the same
    // table: `wallet_transactions.actor_user_id`, which is what makes §10.5's "who adjusted
    // this balance" unerasable. Both are checked here rather than caught, so an unexpected
    // refusal on some *other* constraint still fails this suite.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    const acted = await db
      .selectFrom('wallet_transactions')
      .select('id')
      .where('actor_user_id', '=', id)
      .executeTakeFirst();

    if (held || acted) {
      continue;
    }

    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

/**
 * A user with a phone number nothing else has taken.
 *
 * The twenty-attempt retry this replaced existed because the employers here cannot be
 * deleted - see `afterAll` - so the suite's numbers accumulated across runs. `fixturePhone`
 * draws from eleven digits rather than seven, which ends the collision it was guarding.
 */
async function newUser(
  role: 'candidate' | 'employer' | 'admin',
): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ phone: fixturePhone(), locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  // **The two preconditions `unlock` checks, inserted directly.**
  //
  // Since M12's retrofit, buying an unlock requires a *verified* employer (§7 - an employer
  // who cannot see candidates must not be charged for access to one) and a candidate who
  // actually has a profile. Both are written here rather than through `EmployersService` and
  // `CandidatesService`, because this suite deliberately constructs one service: what it
  // tests is the **ledger** - triggers, indexes, row locks - and wiring the schema stack in
  // would obscure that. The gate itself is covered through the real services in
  // `applications/unlock-gating.int.spec.ts`, including its refusing side.
  if (role === 'employer') {
    await db
      .insertInto('employers')
      .values({
        user_id: row.id,
        type: 'company',
        verification_status: 'verified',
        // `employers_verified_at_present` refuses a verified employer with no timestamp,
        // which is the schema declining to represent a half-finished decision.
        verified_at: sql`now()`,
        // BR-03's stored completeness. `assertVerified` requires it as well, because §7's
        // gate is "may this employer see candidates at all", and the unlock now asks the
        // same question before charging - so the fixture has to satisfy the same gate a
        // real employer would.
        is_complete: true,
      })
      .execute();
  }

  if (role === 'candidate') {
    await db
      .insertInto('candidate_profiles')
      .values({ user_id: row.id })
      .execute();
  }

  return row.id;
}

/** An employer with a wallet holding exactly this many Coins, through the real paths. */
async function employerWith(coins: number): Promise<string> {
  const employerUserId = await newUser('employer');

  await db.transaction().execute(async (trx) => {
    await wallet.grantRegistrationBonus(trx, employerUserId);
  });

  if (coins === 10) {
    return employerUserId;
  }

  // Anything other than the bonus is reached by an adjustment, which is a real ledger
  // entry - so even the fixture cannot put the wallet in a state the product could not.
  const admin = await newUser('admin');
  await wallet.adjust(
    admin,
    employerUserId,
    coins - 10,
    'Test fixture balance.',
  );

  return employerUserId;
}

/** The invariant the cached balance exists to speed up, and must never contradict. */
async function ledgerSum(employerUserId: string): Promise<number> {
  const row = await sql<{ sum: string | null }>`
    SELECT sum(amount_coins) AS sum FROM wallet_transactions
    WHERE employer_user_id = ${employerUserId}
  `.execute(db);

  return Number(row.rows[0]?.sum ?? 0);
}

describe('the registration bonus (BR-15)', () => {
  it('credits ten Coins once, and records when', async () => {
    const employerUserId = await employerWith(10);
    const view = await wallet.read(employerUserId);

    expect(view.balanceCoins).toBe(10);
    expect(view.registrationBonusAt).toBeInstanceOf(Date);
    expect(await ledgerSum(employerUserId)).toBe(10);
  });

  it('is not granted twice, however many times it is attempted', async () => {
    const employerUserId = await employerWith(10);

    // §6.6's "not again after logout, reinstall, device change, or role switching" - all
    // four are this call happening again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .transaction()
        .execute((trx) => wallet.grantRegistrationBonus(trx, employerUserId));
    }

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
    expect(
      await db
        .selectFrom('wallet_transactions')
        .select('id')
        .where('employer_user_id', '=', employerUserId)
        .where('kind', '=', 'registration_bonus')
        .execute(),
    ).toHaveLength(1);
  });

  it('is not granted twice when two registrations race', async () => {
    const employerUserId = await newUser('employer');

    // The partial unique index is the whole defence here: both transactions read no
    // existing bonus, and one of them loses at the index rather than crediting twice.
    const results = await Promise.allSettled([
      db
        .transaction()
        .execute((trx) => wallet.grantRegistrationBonus(trx, employerUserId)),
      db
        .transaction()
        .execute((trx) => wallet.grantRegistrationBonus(trx, employerUserId)),
    ]);

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
    expect(await ledgerSum(employerUserId)).toBe(10);
  });

  it('reaches an employer who registered before the wallet existed', async () => {
    const employerUserId = await newUser('employer');

    // These employers exist on the deployed instance: they have the role and no bonus
    // row. Their first wallet read grants it, because the index rather than the order of
    // calls is what makes the bonus one-time.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
  });

  it('cannot be minted again by an employer who has already spent it', async () => {
    const employerUserId = await employerWith(10);
    const candidateUserId = await newUser('candidate');

    await wallet.unlock(employerUserId, candidateUserId);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);

    // The case that would be a real exploit if the bonus were guarded by "the wallet has
    // no rows" or "the balance is zero": read the screen again, or switch roles, and get
    // topped back up.
    await db
      .transaction()
      .execute((trx) => wallet.grantRegistrationBonus(trx, employerUserId));
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
  });
});

describe('Candidate Unlock (BR-16, BR-18)', () => {
  it('debits the cost and grants the entitlement together', async () => {
    const employerUserId = await employerWith(10);
    const candidateUserId = await newUser('candidate');

    const unlock = await wallet.unlock(employerUserId, candidateUserId);

    // UAT-17: 2 Coins debited, balance becomes 8.
    expect(unlock).toMatchObject({ costCoins: 2, charged: true });
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
    expect(await wallet.hasUnlock(employerUserId, candidateUserId)).toBe(true);

    // BR-18: the ledger row and the entitlement reference each other, so neither can
    // exist alone.
    const row = await db
      .selectFrom('candidate_unlocks')
      .innerJoin(
        'wallet_transactions',
        'wallet_transactions.id',
        'candidate_unlocks.transaction_id',
      )
      .select(['wallet_transactions.amount_coins', 'wallet_transactions.kind'])
      .where('candidate_unlocks.employer_user_id', '=', employerUserId)
      .where('candidate_unlocks.candidate_user_id', '=', candidateUserId)
      .executeTakeFirstOrThrow();

    expect(row).toMatchObject({ amount_coins: -2, kind: 'candidate_unlock' });
  });

  it('charges the same pair once, however often it is asked (UAT-18)', async () => {
    const employerUserId = await employerWith(10);
    const candidateUserId = await newUser('candidate');

    const first = await wallet.unlock(employerUserId, candidateUserId);
    const second = await wallet.unlock(employerUserId, candidateUserId);
    const third = await wallet.unlock(employerUserId, candidateUserId);

    expect(first.charged).toBe(true);
    expect(second.charged).toBe(false);
    expect(third.charged).toBe(false);
    // Balance moved once, and the later calls returned the original entitlement.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
    expect(second.createdAt).toEqual(first.createdAt);
  });

  it('charges once when two taps race (BR-16)', async () => {
    const employerUserId = await employerWith(10);
    const candidateUserId = await newUser('candidate');

    // Two genuinely concurrent requests. The row lock serializes them and the pair's
    // primary key is the backstop; between them, exactly one debit may happen.
    const results = await Promise.allSettled([
      wallet.unlock(employerUserId, candidateUserId),
      wallet.unlock(employerUserId, candidateUserId),
    ]);

    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeGreaterThan(0);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
    expect(
      await db
        .selectFrom('wallet_transactions')
        .select('id')
        .where('employer_user_id', '=', employerUserId)
        .where('kind', '=', 'candidate_unlock')
        .execute(),
    ).toHaveLength(1);
  });

  it('debits each of two different candidates when both race', async () => {
    const employerUserId = await employerWith(10);
    const first = await newUser('candidate');
    const second = await newUser('candidate');

    // The case the row lock exists for: two *different* pairs, so no unique constraint
    // helps. Without the lock both read balance 10 and both write balance_after 8,
    // losing a debit - and the ledger sum would disagree with the cached balance.
    await Promise.all([
      wallet.unlock(employerUserId, first),
      wallet.unlock(employerUserId, second),
    ]);

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(6);
    expect(await ledgerSum(employerUserId)).toBe(6);
  });

  it('refuses when the balance is too low, and writes nothing (UAT-19)', async () => {
    const employerUserId = await employerWith(1);
    const candidateUserId = await newUser('candidate');

    await expect(
      wallet.unlock(employerUserId, candidateUserId),
    ).rejects.toMatchObject({ messageKey: 'wallet.insufficient_coins' });

    // The important half: the refusal must not have taken the 1 Coin it had, and must
    // not have left an entitlement behind.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(1);
    expect(await wallet.hasUnlock(employerUserId, candidateUserId)).toBe(false);
    expect(
      await db
        .selectFrom('wallet_transactions')
        .select('id')
        .where('employer_user_id', '=', employerUserId)
        .where('kind', '=', 'candidate_unlock')
        .execute(),
    ).toEqual([]);
  });

  it('refuses to unlock the employer’s own candidate profile', async () => {
    const employerUserId = await employerWith(10);

    // A multi-role account holds both roles (§2.3), so this is an ordinary user's
    // mistake rather than a malformed request.
    await expect(
      wallet.unlock(employerUserId, employerUserId),
    ).rejects.toMatchObject({ messageKey: 'wallet.cannot_unlock_self' });
  });

  it('spends a balance down to zero and then refuses', async () => {
    const employerUserId = await employerWith(4);
    const first = await newUser('candidate');
    const second = await newUser('candidate');
    const third = await newUser('candidate');

    await wallet.unlock(employerUserId, first);
    await wallet.unlock(employerUserId, second);

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(0);
    await expect(wallet.unlock(employerUserId, third)).rejects.toMatchObject({
      messageKey: 'wallet.insufficient_coins',
    });
  });
});

describe('the ledger filter (§06, E-52)', () => {
  it('answers one side of the ledger, from the whole ledger', async () => {
    const employerUserId = await newUser('employer');

    // A bonus in, an unlock out, an adjustment in: three rows, two signs.
    await wallet.read(employerUserId);
    await wallet.unlock(employerUserId, await newUser('candidate'));
    await wallet.adjust(
      await newUser('admin'),
      employerUserId,
      5,
      'Support credit',
    );

    const all = await wallet.transactions(employerUserId, 50, 0);
    const credits = await wallet.transactions(employerUserId, 50, 0, 'credit');
    const debits = await wallet.transactions(employerUserId, 50, 0, 'debit');

    expect(all).toHaveLength(3);
    expect(credits.every((row) => row.amountCoins > 0)).toBe(true);
    expect(debits.every((row) => row.amountCoins < 0)).toBe(true);
    // Exhaustive: zero is not a legal amount, so every row is on one side.
    expect(credits.length + debits.length).toBe(all.length);
  });

  it('pages the filtered ledger, not the page it filtered', async () => {
    const employerUserId = await newUser('employer');
    await wallet.read(employerUserId);

    const admin = await newUser('admin');
    for (let i = 0; i < 3; i++) {
      await wallet.adjust(admin, employerUserId, -1, `Correction ${i}`);
    }

    // The **newest** row is a credit on purpose. Without it the first two rows
    // of the unfiltered ledger happen to be debits anyway, and the case would
    // pass with the filter removed - which is the only thing it is here to
    // notice.
    await wallet.adjust(admin, employerUserId, 5, 'Support credit');

    const unfiltered = await wallet.transactions(employerUserId, 2, 0);
    expect(unfiltered.some((row) => row.amountCoins > 0)).toBe(true);

    // **This is the bug the parameter exists for.** Filtering after paging
    // gives "the debits among the first two rows" - one of them here.
    // Filtering before it gives the first two debits.
    const firstTwo = await wallet.transactions(employerUserId, 2, 0, 'debit');

    expect(firstTwo).toHaveLength(2);
    expect(firstTwo.every((row) => row.amountCoins < 0)).toBe(true);
  });
});

describe('the ledger (BR-24)', () => {
  it('refuses an UPDATE, whatever it matches', async () => {
    const employerUserId = await employerWith(10);

    // Statement-level, so even an UPDATE matching no rows is refused - a row trigger
    // would let `WHERE false` report a success it did not perform.
    await expect(
      db
        .updateTable('wallet_transactions')
        .set({ amount_coins: 999 })
        .where('employer_user_id', '=', employerUserId)
        .execute(),
    ).rejects.toThrow(/append-only/);

    await expect(
      db
        .updateTable('wallet_transactions')
        .set({ amount_coins: 999 })
        .where('id', '=', '00000000-0000-4000-8000-000000000000')
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await expect(
      db
        .deleteFrom('wallet_transactions')
        .where('id', '=', '00000000-0000-4000-8000-000000000000')
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps the cached balance equal to the sum of the ledger', async () => {
    const employerUserId = await employerWith(10);
    const admin = await newUser('admin');
    const first = await newUser('candidate');
    const second = await newUser('candidate');

    // A mixed sequence across every kind this milestone can write.
    await wallet.unlock(employerUserId, first);
    await wallet.adjust(
      admin,
      employerUserId,
      5,
      'Goodwill for a support case.',
    );
    await wallet.unlock(employerUserId, second);
    await wallet.adjust(admin, employerUserId, -1, 'Correcting the goodwill.');

    const view = await wallet.read(employerUserId);

    // 10 - 2 + 5 - 2 - 1
    expect(view.balanceCoins).toBe(10);
    expect(await ledgerSum(employerUserId)).toBe(view.balanceCoins);
  });

  it('records the price at the time, not today’s price', async () => {
    const employerUserId = await employerWith(10);
    const candidateUserId = await newUser('candidate');

    await wallet.unlock(employerUserId, candidateUserId);

    // §10.5: repricing "affects future transactions only and does not rewrite historical
    // ledger records". Storing the price is what makes that possible.
    const row = await db
      .selectFrom('wallet_transactions')
      .select(['coin_price_uzs', 'amount_uzs'])
      .where('employer_user_id', '=', employerUserId)
      .where('kind', '=', 'candidate_unlock')
      .executeTakeFirstOrThrow();

    expect(Number(row.coin_price_uzs)).toBe(10_000);
    expect(Number(row.amount_uzs)).toBe(20_000);
  });
});

describe('the administrator adjustment (§10.5)', () => {
  it('credits with a reason, as a new ledger entry', async () => {
    const employerUserId = await employerWith(10);
    const admin = await newUser('admin');

    const row = await wallet.adjust(
      admin,
      employerUserId,
      3,
      'Compensation for an outage.',
    );

    expect(row).toMatchObject({
      kind: 'admin_adjustment',
      amountCoins: 3,
      balanceAfter: 13,
    });
    expect(row.reason).toContain('outage');
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(13);
  });

  it('refuses a debit larger than the balance', async () => {
    const employerUserId = await employerWith(10);
    const admin = await newUser('admin');

    // Caught before the insert, so the failure is a clear message rather than a
    // constraint violation surfacing as a 500.
    await expect(
      wallet.adjust(admin, employerUserId, -11, 'Too much.'),
    ).rejects.toMatchObject({
      messageKey: 'wallet.adjustment_would_go_negative',
    });

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
  });

  it('cannot be written without a reason, even bypassing the service', async () => {
    const employerUserId = await employerWith(10);
    const admin = await newUser('admin');

    // §10.5's "only with a mandatory reason" is a database check, so a future service
    // that forgot it would be refused rather than silently allowed.
    await expect(
      db
        .insertInto('wallet_transactions')
        .values({
          employer_user_id: employerUserId,
          kind: 'admin_adjustment',
          amount_coins: 5,
          balance_before: 10,
          balance_after: 15,
          actor_user_id: admin,
        })
        .execute(),
    ).rejects.toThrow(/adjustment_has_reason/);
  });
});
