import { createHash, randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import type { PaymentOrderStatus } from '@infra/db/database.types';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { EmployersService } from '@modules/employers/employers.service';
import { PricingService } from '@modules/wallet/pricing.service';
import { WalletService } from '@modules/wallet/wallet.service';

import { PaymentOrdersService } from './payment-orders.service';
import { ClickProvider } from './providers/click.provider';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { PaymeProvider } from './providers/payme.provider';

/**
 * Payment Orders against a real Postgres (§6.7, §12.6, BR-19, BR-20).
 *
 * Everything BR-19 promises is a database guarantee - a row lock, a conditional update, two
 * unique indexes - so over `DummyDriver` every test here would compile its queries, run
 * nothing, and pass while exactly-once crediting was entirely absent. The tests that matter
 * most deliver the **same callback twice**, once sequentially (UAT-22) and once
 * concurrently, because a top-up is the one place in this product where losing a race means
 * either an employer paid for nothing or was given Coins twice.
 *
 * The wire formats themselves are unit-tested in `providers/payment-providers.spec.ts`;
 * these tests go in through the real callback entry point with real signatures, because a
 * state machine tested through a mocked parser is a state machine tested against itself.
 *
 * **This suite deliberately leaves its rows behind.** `payment_events` is append-only, so
 * even its own test cannot delete an event, and `payment_orders` is `RESTRICT`-referenced by
 * those events. That is the third time this product has met that shape - the audit log, then
 * the wallet ledger, now the payment trail - and the answer is the same each time: §6.7
 * requires payment records "for support and reconciliation", so BR-14's purge anonymizes
 * these accounts rather than deleting them.
 */

const PAYME_KEY = 'int-test-payme-key';
const CLICK_SECRET = 'int-test-click-secret';
const COIN_PRICE = 10_000;
const BONUS = 10;

let db: Database;
let destroy: () => Promise<void>;
let wallet: WalletService;
let orders: PaymentOrdersService;
let payme: PaymeProvider;
let click: ClickProvider;

const users: string[] = [];

const ENV: Record<string, string | number> = {
  COIN_PRICE_UZS: COIN_PRICE,
  CANDIDATE_UNLOCK_COINS: 2,
  EMPLOYER_REGISTRATION_BONUS_COINS: BONUS,
  PAYMENT_MIN_COINS: 1,
  PAYMENT_MAX_COINS: 1_000,
  PAYME_MERCHANT_ID: 'int-merchant',
  PAYME_MERCHANT_KEY: PAYME_KEY,
  PAYME_CHECKOUT_URL: 'https://checkout.paycom.uz',
  PAYME_ACCOUNT_FIELD: 'order_id',
  CLICK_MERCHANT_ID: 'int-click-merchant',
  CLICK_SERVICE_ID: 'int-click-service',
  CLICK_SECRET_KEY: CLICK_SECRET,
  CLICK_MERCHANT_USER_ID: '',
  CLICK_CHECKOUT_URL: 'https://my.click.uz/services/pay',
};

const config = {
  get: (key: string) => ENV[key],
} as unknown as ConfigService<AppEnv, true>;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  wallet = new WalletService(
    db,
    new EmployersService(db),
    new PricingService(db, config),
  );
  payme = new PaymeProvider(config);
  click = new ClickProvider(config);
  orders = new PaymentOrdersService(
    db,
    new PaymentProviderRegistry(payme, click),
    wallet,
    config,
  );
});

afterAll(async () => {
  for (const id of users) {
    // The reversal test spends its Coins on real unlocks, and
    // `candidate_unlocks.candidate_user_id` is RESTRICT because an employer paid for that
    // row. The entitlements go before the users they point at.
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
    // Every employer here holds a wallet, and `employer_wallets.user_id` is
    // `ON DELETE RESTRICT` - see the header. Candidates and any employer that never got as
    // far as a wallet can still go.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    if (held) {
      continue;
    }

    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

/**
 * An employer, with a phone number nothing else has taken.
 *
 * This used to be a twenty-attempt retry loop against the unique index, because the suite
 * cannot delete the employers it creates - see the header - so its numbers accumulated
 * across runs and a random one eventually collided with a row an earlier run left behind.
 * `fixturePhone` draws from eleven digits instead of seven, which moves a collision from
 * once every few hundred inserts to once in a billion - so there is nothing left to retry.
 */
async function newEmployer(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ phone: fixturePhone(), locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('user_roles')
    .values({ user_id: row.id, role: 'employer' })
    .execute();
  users.push(row.id);

  // A verified, complete employer profile and a candidate profile on the same row.
  //
  // The reversal test spends its Coins through real `unlock` calls, and since M12's retrofit
  // that requires §7's gate to pass (an employer who cannot see candidates must not be
  // charged for access to one) and the target to have a profile. Inserted directly because
  // this suite constructs the payment stack, not the profile stack - the gate itself is
  // covered through the real services in `applications/unlock-gating.int.spec.ts`.
  await db
    .insertInto('employers')
    .values({
      user_id: row.id,
      type: 'company',
      verification_status: 'verified',
      verified_at: sql`now()`,
      is_complete: true,
    })
    .execute();
  await db
    .insertInto('candidate_profiles')
    .values({ user_id: row.id })
    .execute();

  return row.id;
}

/** An employer with an order open for `coins`, through the real creation path. */
async function orderFor(
  provider: 'payme' | 'click',
  coins = 10,
): Promise<{ employerUserId: string; orderId: string; amountUzs: number }> {
  const employerUserId = await newEmployer();
  const { order } = await orders.create(
    employerUserId,
    provider,
    coins,
    'uz-Latn',
  );

  return { employerUserId, orderId: order.id, amountUzs: order.amountUzs };
}

const basic = `Basic ${Buffer.from(`Paycom:${PAYME_KEY}`, 'utf8').toString('base64')}`;

/** A Payme JSON-RPC callback, authenticated. */
function paymeCall(
  method: string,
  params: Record<string, unknown>,
): { headers: Record<string, string>; body: unknown } {
  return {
    headers: { authorization: basic },
    body: { method, params, id: 1 },
  };
}

function paymeAccount(orderId: string): Record<string, unknown> {
  return { order_id: orderId };
}

/** CLICK's documented sign string, rebuilt here rather than borrowed from the adapter. */
function clickSign(parts: (string | number)[]): string {
  return createHash('md5').update(parts.join(''), 'utf8').digest('hex');
}

function clickCall(
  action: '0' | '1',
  fields: {
    orderId: string;
    amountUzs: number;
    clickTransId: string;
    prepareId?: string;
    error?: string;
    signature?: string;
  },
): { headers: Record<string, string>; body: unknown } {
  const amount = fields.amountUzs.toFixed(2);
  const signTime = '2026-08-18 12:00:00';
  const parts = [
    fields.clickTransId,
    ENV.CLICK_SERVICE_ID as string,
    CLICK_SECRET,
    fields.orderId,
    ...(action === '1' ? [fields.prepareId ?? ''] : []),
    amount,
    action,
    signTime,
  ];

  return {
    headers: {},
    body: {
      click_trans_id: fields.clickTransId,
      service_id: ENV.CLICK_SERVICE_ID,
      merchant_trans_id: fields.orderId,
      ...(action === '1' ? { merchant_prepare_id: fields.prepareId } : {}),
      amount,
      action,
      error: fields.error ?? '0',
      sign_time: signTime,
      sign_string: fields.signature ?? clickSign(parts),
    },
  };
}

async function statusOf(orderId: string): Promise<PaymentOrderStatus> {
  const row = await db
    .selectFrom('payment_orders')
    .select('status')
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();

  return row.status;
}

async function balanceOf(employerUserId: string): Promise<number> {
  const row = await db
    .selectFrom('employer_wallets')
    .select('balance_coins')
    .where('user_id', '=', employerUserId)
    .executeTakeFirstOrThrow();

  return row.balance_coins;
}

/** The invariant the cached balance must never contradict. */
async function ledgerSum(employerUserId: string): Promise<number> {
  const row = await sql<{ sum: string | null }>`
    SELECT sum(amount_coins) AS sum FROM wallet_transactions
    WHERE employer_user_id = ${employerUserId}
  `.execute(db);

  return Number(row.rows[0]?.sum ?? 0);
}

async function topUpRows(orderId: string): Promise<number> {
  const rows = await db
    .selectFrom('wallet_transactions')
    .select('id')
    .where('kind', '=', 'top_up')
    .where('reference_id', '=', orderId)
    .execute();

  return rows.length;
}

async function eventsFor(
  orderId: string,
): Promise<{ method: string; result: string; detail: string | null }[]> {
  const rows = await db
    .selectFrom('payment_events')
    .select(['method', 'result', 'detail'])
    .where('order_id', '=', orderId)
    .orderBy('created_at', 'asc')
    .execute();

  return rows;
}

describe("§10.5's administrator search", () => {
  /** Only the orders this test made: the development database has others. */
  async function found(
    filters: Parameters<PaymentOrdersService['search']>[0],
    mine: string[],
  ): Promise<string[]> {
    const rows = await orders.search(filters, 100, 0);

    return rows.map((row) => row.id).filter((id) => mine.includes(id));
  }

  it('finds an order by its employer', async () => {
    // `list` is scoped to its caller because an order id is an identifier and
    // not an authorization. This is the deliberate exception, and the role
    // guard is what makes it safe.
    const a = await orderFor('payme');
    const b = await orderFor('click');

    expect(
      await found({ employerUserId: a.employerUserId }, [a.orderId, b.orderId]),
    ).toEqual([a.orderId]);
  });

  it('finds one by provider', async () => {
    const payme = await orderFor('payme');
    const click = await orderFor('click');

    expect(
      await found({ provider: 'click' }, [payme.orderId, click.orderId]),
    ).toEqual([click.orderId]);
  });

  it('finds one by its internal id, which is what support quotes', async () => {
    const a = await orderFor('payme');
    const b = await orderFor('payme');

    expect(await found({ orderId: a.orderId }, [a.orderId, b.orderId])).toEqual(
      [a.orderId],
    );
  });

  it('finds one by the provider transaction id, exactly', async () => {
    // Exact rather than a prefix: this is quoted from a provider dashboard or a
    // ticket, so a partial match would answer a question nobody asked.
    //
    // The id is minted per run because the column is UNIQUE — one order per
    // provider transaction, deliberately — and this development database is
    // shared, so a fixed string collides with the previous run's row.
    const a = await orderFor('payme');
    const b = await orderFor('payme');
    const transactionId = `PX-${randomUUID()}`;
    await db
      .updateTable('payment_orders')
      .set({ provider_transaction_id: transactionId })
      .where('id', '=', a.orderId)
      .execute();

    expect(
      await found({ providerTransactionId: transactionId }, [
        a.orderId,
        b.orderId,
      ]),
    ).toEqual([a.orderId]);
    expect(
      await found({ providerTransactionId: transactionId.slice(0, 8) }, [
        a.orderId,
        b.orderId,
      ]),
    ).toEqual([]);
  });

  it('finds one by status', async () => {
    const a = await orderFor('payme');
    const b = await orderFor('payme');
    // `paid` carries a CHECK that it be traceable - a paid order with no
    // timestamp and no provider reference is money nobody can account for.
    await db
      .updateTable('payment_orders')
      .set({
        status: 'paid',
        paid_at: new Date(),
        provider_transaction_id: `PX-${randomUUID()}`,
      })
      .where('id', '=', a.orderId)
      .execute();

    expect(await found({ status: 'paid' }, [a.orderId, b.orderId])).toEqual([
      a.orderId,
    ]);
  });

  it('excludes an order created before the window', async () => {
    const a = await orderFor('payme');
    const b = await orderFor('payme');
    await db
      .updateTable('payment_orders')
      .set({ created_at: new Date('2020-01-01T00:00:00Z') })
      .where('id', '=', a.orderId)
      .execute();

    const recent = await found(
      { from: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      [a.orderId, b.orderId],
    );

    expect(recent).toEqual([b.orderId]);
  });

  it('ANDs its filters rather than choosing between them', async () => {
    // A search screen narrows. Two axes that disagree find nothing, which is
    // the answer.
    const a = await orderFor('payme');

    expect(
      await found({ employerUserId: a.employerUserId, provider: 'click' }, [
        a.orderId,
      ]),
    ).toEqual([]);
  });

  it('with no filters at all, answers the whole log newest first', async () => {
    const first = await orderFor('payme');
    const second = await orderFor('click');

    const mine = [first.orderId, second.orderId];
    const rows = (await orders.search({}, 100, 0))
      .map((row) => row.id)
      .filter((id) => mine.includes(id));

    expect(rows).toEqual([second.orderId, first.orderId]);
  });
});

describe('opening a Payment Order (§6.7, §12.3.1)', () => {
  it('calculates the payable amount from the Coin price, server-side', async () => {
    const employerUserId = await newEmployer();
    const { order, checkout } = await orders.create(
      employerUserId,
      'payme',
      10,
      'ru',
    );

    // §6.7's own example: 10 Coins at the initial price equals UZS 100 000.
    expect(order.coins).toBe(10);
    expect(order.amountUzs).toBe(100_000);
    expect(order.coinPriceUzs).toBe(COIN_PRICE);
    expect(order.status).toBe('created');
    expect(checkout.url).toContain('checkout.paycom.uz');
  });

  it('stores the price on the order, so a later repricing cannot change it (§10.5)', async () => {
    const employerUserId = await newEmployer();
    const { order } = await orders.create(employerUserId, 'payme', 5, 'ru');

    // A repricing after the order was opened.
    const repriced = new PaymentOrdersService(
      db,
      new PaymentProviderRegistry(payme, click),
      new WalletService(
        db,
        new EmployersService(db),
        new PricingService(db, {
          get: (key: string) => (key === 'COIN_PRICE_UZS' ? 20_000 : ENV[key]),
        } as unknown as ConfigService<AppEnv, true>),
      ),
      config,
    );

    const reread = await repriced.read(employerUserId, order.id);

    expect(reread.coinPriceUzs).toBe(COIN_PRICE);
    expect(reread.amountUzs).toBe(50_000);
  });

  it('refuses a Coin count outside the configured bounds', async () => {
    const employerUserId = await newEmployer();

    await expect(
      orders.create(employerUserId, 'payme', 0, 'ru'),
    ).rejects.toThrow();
    await expect(
      orders.create(employerUserId, 'payme', 10_000, 'ru'),
    ).rejects.toThrow();
    await expect(
      orders.create(employerUserId, 'payme', 1.5, 'ru'),
    ).rejects.toThrow();
  });

  it('refuses a provider with no merchant account configured', async () => {
    const employerUserId = await newEmployer();
    const noProviders = new PaymentOrdersService(
      db,
      new PaymentProviderRegistry(
        new PaymeProvider({
          get: (key: string) =>
            key === 'PAYME_MERCHANT_ID' || key === 'PAYME_MERCHANT_KEY'
              ? ''
              : ENV[key],
        } as unknown as ConfigService<AppEnv, true>),
        click,
      ),
      wallet,
      config,
    );

    expect(noProviders.availableProviders()).toEqual(['click']);
    await expect(
      noProviders.create(employerUserId, 'payme', 10, 'ru'),
    ).rejects.toThrow();
  });

  it('scopes an order read to its owner', async () => {
    const { orderId } = await orderFor('payme');
    const somebodyElse = await newEmployer();

    await expect(orders.read(somebodyElse, orderId)).rejects.toThrow();
  });
});

describe('the Payme lifecycle (§12.6)', () => {
  it('allows a check on a fresh order at the right amount, and changes nothing', async () => {
    const { orderId, amountUzs } = await orderFor('payme');

    const response = await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    expect(response.body).toMatchObject({ result: { allow: true } });
    expect(await statusOf(orderId)).toBe('created');
    expect(await eventsFor(orderId)).toEqual([
      {
        method: 'CheckPerformTransaction',
        result: 'verified',
        detail: 'payable',
      },
    ]);
  });

  it('refuses a wrong amount and records why (§12.3.1)', async () => {
    const { orderId, amountUzs } = await orderFor('payme');

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        // One soum short: an exact comparison, not a tolerance.
        amount: (amountUzs - 1) * 100,
        account: paymeAccount(orderId),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31001);
    expect(await statusOf(orderId)).toBe('created');
    expect(await eventsFor(orderId)).toEqual([
      {
        method: 'CheckPerformTransaction',
        result: 'rejected',
        detail: 'invalid_amount',
      },
    ]);
  });

  it('records a callback for an order that does not exist, with no order to attach it to', async () => {
    const before = await countEvents();

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        amount: 100,
        account: paymeAccount('99999999-8888-4777-8666-555555555555'),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31050);
    // The trail's most important row: it is the only evidence an incident review would have.
    expect(await countEvents()).toBe(before + 1);
  });

  it('survives an account field that is not a UUID at all', async () => {
    // `WHERE id = 'garbage'` is a Postgres type error, which would abort the transaction and
    // take the event row explaining it with it.
    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        amount: 100,
        account: paymeAccount("'; DROP TABLE payment_orders; --"),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31050);
    // Still there, and still answering.
    expect(
      await db.selectFrom('payment_orders').select('id').limit(1).execute(),
    ).toBeDefined();
  });

  it('opens a transaction, and answers a repeat of it identically (§12.6)', async () => {
    const { orderId, amountUzs } = await orderFor('payme');
    const create = paymeCall('CreateTransaction', {
      id: `ptx-${orderId}`,
      amount: amountUzs * 100,
      account: paymeAccount(orderId),
    });

    const first = (await orders.handleCallback('payme', create)) as {
      body: { result: { transaction: string; state: number } };
    };

    expect(first.body.result).toMatchObject({
      transaction: orderId,
      state: 1,
    });
    expect(await statusOf(orderId)).toBe('pending');

    // §12.6 asks for repeated Create requests to be tested for idempotent behaviour.
    const second = (await orders.handleCallback('payme', create)) as {
      body: { result: { transaction: string; state: number } };
    };

    expect(second.body.result).toMatchObject({
      transaction: orderId,
      state: 1,
    });
    expect((await eventsFor(orderId)).map((e) => e.detail)).toEqual([
      'opened',
      'already_open',
    ]);
  });

  it('refuses a second, different transaction against one order', async () => {
    const { orderId, amountUzs } = await orderFor('payme');

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: `ptx-a-${orderId}`,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    // Two live transactions against one order is how an order gets paid twice.
    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: `ptx-b-${orderId}`,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31008);
  });

  it('credits the Coins once the transaction performs (UAT-20)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    )) as { body: { result: { state: number } } };

    expect(response.body.result.state).toBe(2);
    expect(await statusOf(orderId)).toBe('paid');
    // The registration bonus plus the ten Coins that were bought.
    expect(await balanceOf(employerUserId)).toBe(BONUS + 10);
    // The invariant that keeps a denormalized balance honest.
    expect(await ledgerSum(employerUserId)).toBe(BONUS + 10);
    expect(await topUpRows(orderId)).toBe(1);
  });

  it('credits nothing the second time the same callback arrives (UAT-22, BR-19)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;
    const perform = paymeCall('PerformTransaction', { id: transactionId });

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    await orders.handleCallback('payme', perform);
    const balanceAfterFirst = await balanceOf(employerUserId);

    // The most important test in the milestone.
    const second = (await orders.handleCallback('payme', perform)) as {
      body: { result: { state: number } };
    };

    // Still a success from the provider's point of view - telling it otherwise makes it
    // retry forever - and still exactly one credit.
    expect(second.body.result.state).toBe(2);
    expect(await balanceOf(employerUserId)).toBe(balanceAfterFirst);
    expect(await topUpRows(orderId)).toBe(1);
    expect((await eventsFor(orderId)).map((e) => e.detail)).toEqual([
      'opened',
      'paid_and_credited',
      'already_paid',
    ]);
  });

  it('credits once when two identical callbacks race (BR-19)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    const perform = () =>
      orders.handleCallback(
        'payme',
        paymeCall('PerformTransaction', { id: transactionId }),
      );

    // The row lock is what makes this deterministic; without it both transactions read
    // `pending` and both credit.
    const [first, second] = await Promise.all([perform(), perform()]);

    for (const response of [first, second]) {
      expect(response.body).toMatchObject({ result: { state: 2 } });
    }

    expect(await topUpRows(orderId)).toBe(1);
    expect(await balanceOf(employerUserId)).toBe(BONUS + 10);
    expect(await ledgerSum(employerUserId)).toBe(BONUS + 10);
  });

  it('reports the transaction state on a status poll', async () => {
    const { orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );
    await orders.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CheckTransaction', { id: transactionId }),
    )) as { body: { result: { state: number; perform_time: number } } };

    expect(response.body.result.state).toBe(2);
    expect(response.body.result.perform_time).toBeGreaterThan(0);
  });

  it('lists transactions in a window for reconciliation', async () => {
    const { orderId, amountUzs } = await orderFor('payme', 3);

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: `ptx-${orderId}`,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('GetStatement', {
        from: Date.now() - 60_000,
        to: Date.now() + 60_000,
      }),
    )) as { body: { result: { transactions: { transaction: string }[] } } };

    expect(
      response.body.result.transactions.map((row) => row.transaction),
    ).toContain(orderId);
  });
});

describe('failed and cancelled payments never credit (BR-20, UAT-23)', () => {
  it('cancels a pending order without any Coin ever existing', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CancelTransaction', { id: transactionId, reason: 3 }),
    )) as { body: { result: { state: number } } };

    expect(response.body.result.state).toBe(-1);
    expect(await statusOf(orderId)).toBe('cancelled');
    expect(await topUpRows(orderId)).toBe(0);
    expect(await balanceOf(employerUserId)).toBe(BONUS);
  });

  it('refuses to perform a cancelled transaction', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );
    await orders.handleCallback(
      'payme',
      paymeCall('CancelTransaction', { id: transactionId, reason: 3 }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31008);
    expect(await topUpRows(orderId)).toBe(0);
    expect(await balanceOf(employerUserId)).toBe(BONUS);
  });

  it('reverses a paid order with a new ledger row, rewriting nothing (BR-24)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );
    await orders.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CancelTransaction', { id: transactionId, reason: 5 }),
    )) as { body: { result: { state: number } } };

    // -2, Payme's "cancelled after perform".
    expect(response.body.result.state).toBe(-2);
    expect(await statusOf(orderId)).toBe('reversed');
    expect(await balanceOf(employerUserId)).toBe(BONUS);
    // The credit is still there; the reversal is a *second* row.
    expect(await topUpRows(orderId)).toBe(1);
    expect(await ledgerSum(employerUserId)).toBe(BONUS);

    const kinds = await db
      .selectFrom('wallet_transactions')
      .select('kind')
      .where('employer_user_id', '=', employerUserId)
      .orderBy('created_at', 'asc')
      .execute();

    expect(kinds.map((row) => row.kind)).toEqual([
      'registration_bonus',
      'top_up',
      'reversal',
    ]);
  });

  it('recovers only what is left when the Coins were already spent', async () => {
    // The decision `WalletService.reverseTopUp` documents: an unlock the employer already
    // used is permanent (BR-16), so a full debit would drive the balance negative and abort
    // the transaction, leaving the order stuck at `paid` while the provider believed it
    // refunded. docs/PAYMENTS.md carries this to the client as a commercial question.
    const { employerUserId, orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );
    await orders.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    );

    // Spend everything: 20 Coins is ten unlocks at 2 Coins each.
    for (let index = 0; index < 10; index += 1) {
      const candidate = await newEmployer();
      await wallet.unlock(employerUserId, candidate);
    }

    expect(await balanceOf(employerUserId)).toBe(0);

    await orders.handleCallback(
      'payme',
      paymeCall('CancelTransaction', { id: transactionId, reason: 5 }),
    );

    expect(await statusOf(orderId)).toBe('reversed');
    // Nothing to take back, and the balance stays legal rather than going negative.
    expect(await balanceOf(employerUserId)).toBe(0);
    expect(await ledgerSum(employerUserId)).toBe(0);
  });

  it('is idempotent when the same cancellation arrives twice', async () => {
    const { orderId, amountUzs } = await orderFor('payme', 10);
    const transactionId = `ptx-${orderId}`;
    const cancel = paymeCall('CancelTransaction', {
      id: transactionId,
      reason: 3,
    });

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );
    await orders.handleCallback('payme', cancel);
    await orders.handleCallback('payme', cancel);

    expect(await statusOf(orderId)).toBe('cancelled');
    expect((await eventsFor(orderId)).map((e) => e.detail)).toEqual([
      'opened',
      'cancelled',
      'already_cancelled',
    ]);
  });
});

describe('the CLICK lifecycle (UAT-21)', () => {
  it('prepares and completes, crediting once', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('click', 10);

    const prepared = (await orders.handleCallback(
      'click',
      clickCall('0', { orderId, amountUzs, clickTransId: `ctx-${orderId}` }),
    )) as { body: { error: number; merchant_prepare_id: string } };

    expect(prepared.body.error).toBe(0);
    expect(await statusOf(orderId)).toBe('pending');

    const completed = (await orders.handleCallback(
      'click',
      clickCall('1', {
        orderId,
        amountUzs,
        clickTransId: `ctx-${orderId}`,
        // Signed over the value `Prepare` handed out, which is the contract.
        prepareId: prepared.body.merchant_prepare_id,
      }),
    )) as { body: { error: number } };

    expect(completed.body.error).toBe(0);
    expect(await statusOf(orderId)).toBe('paid');
    expect(await balanceOf(employerUserId)).toBe(BONUS + 10);
    expect(await topUpRows(orderId)).toBe(1);
  });

  it('credits nothing on a duplicate Complete (UAT-22)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('click', 10);

    const prepared = (await orders.handleCallback(
      'click',
      clickCall('0', { orderId, amountUzs, clickTransId: `ctx-${orderId}` }),
    )) as { body: { merchant_prepare_id: string } };

    const complete = () =>
      orders.handleCallback(
        'click',
        clickCall('1', {
          orderId,
          amountUzs,
          clickTransId: `ctx-${orderId}`,
          prepareId: prepared.body.merchant_prepare_id,
        }),
      );

    await complete();
    await complete();

    expect(await topUpRows(orderId)).toBe(1);
    expect(await balanceOf(employerUserId)).toBe(BONUS + 10);
  });

  it('leaves the order untouched when the signature does not verify', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('click', 10);

    const response = (await orders.handleCallback(
      'click',
      clickCall('0', {
        orderId,
        amountUzs,
        clickTransId: `ctx-${orderId}`,
        signature: 'deadbeefdeadbeefdeadbeefdeadbeef',
      }),
    )) as { body: { error: number } };

    expect(response.body.error).toBe(-1);
    // §12.6: verification comes before any state change.
    expect(await statusOf(orderId)).toBe('created');
    expect(await balanceOf(employerUserId)).toBe(BONUS);
    // And the attempt is on the record, with no order attached - it was never verified as
    // being about this one.
    expect(await eventsFor(orderId)).toEqual([]);
  });

  it('treats a Complete reporting CLICK’s own error as a cancellation (UAT-23)', async () => {
    const { employerUserId, orderId, amountUzs } = await orderFor('click', 10);

    const prepared = (await orders.handleCallback(
      'click',
      clickCall('0', { orderId, amountUzs, clickTransId: `ctx-${orderId}` }),
    )) as { body: { merchant_prepare_id: string } };

    await orders.handleCallback(
      'click',
      clickCall('1', {
        orderId,
        amountUzs,
        clickTransId: `ctx-${orderId}`,
        prepareId: prepared.body.merchant_prepare_id,
        error: '-31',
      }),
    );

    expect(await statusOf(orderId)).toBe('cancelled');
    expect(await topUpRows(orderId)).toBe(0);
    expect(await balanceOf(employerUserId)).toBe(BONUS);

    // §12.6's "clear status and retry option": the client needs to be able to say why.
    const row = await db
      .selectFrom('payment_orders')
      .select('failure_code')
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();

    expect(row.failure_code).toBe('-31');
  });

  it('refuses a Payme callback aimed at a CLICK order', async () => {
    // The provider is part of every lookup: matching on the order id alone would let one
    // provider act on another's transaction.
    const { orderId, amountUzs } = await orderFor('click', 10);

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31050);
    expect(await statusOf(orderId)).toBe('created');
  });
});

describe('the event trail is append-only (§12.3)', () => {
  it('refuses an UPDATE, a DELETE, and an UPDATE that matches nothing', async () => {
    const { orderId, amountUzs } = await orderFor('payme', 10);

    await orders.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        amount: amountUzs * 100,
        account: paymeAccount(orderId),
      }),
    );

    await expect(
      db
        .updateTable('payment_events')
        .set({ detail: 'rewritten' })
        .where('order_id', '=', orderId)
        .execute(),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.deleteFrom('payment_events').where('order_id', '=', orderId).execute(),
    ).rejects.toThrow(/append-only/);

    // The case a row-level trigger would let through: it never fires for an UPDATE that
    // matches no rows, so `UPDATE ... WHERE false` would report a success.
    await expect(
      db
        .updateTable('payment_events')
        .set({ detail: 'rewritten' })
        .where('id', '=', '00000000-0000-4000-8000-000000000000')
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('cannot record a rejection that also changed the order’s state', async () => {
    const { orderId } = await orderFor('payme', 10);

    // §12.6's ordering, made unrepresentable rather than reviewed for.
    await expect(
      db
        .insertInto('payment_events')
        .values({
          order_id: orderId,
          provider: 'payme',
          method: 'PerformTransaction',
          result: 'rejected',
          status_before: 'pending',
          status_after: 'paid',
        })
        .execute(),
    ).rejects.toThrow(/payment_events_rejected_changes_nothing/);
  });
});

describe('the order row enforces its own arithmetic (§12.3.1)', () => {
  it('refuses an amount that is not the Coin count times the price', async () => {
    const employerUserId = await newEmployer();
    await wallet.read(employerUserId);

    await expect(
      db
        .insertInto('payment_orders')
        .values({
          employer_user_id: employerUserId,
          provider: 'payme',
          coins: 10,
          coin_price_uzs: '10000',
          // A client-supplied total, which is exactly what §12.3.1 forbids trusting.
          amount_uzs: '1',
        })
        .execute(),
    ).rejects.toThrow(/payment_orders_amount_derived/);
  });

  it('refuses a paid order that cannot be traced to a provider transaction', async () => {
    const employerUserId = await newEmployer();
    await wallet.read(employerUserId);

    await expect(
      db
        .insertInto('payment_orders')
        .values({
          employer_user_id: employerUserId,
          provider: 'payme',
          coins: 1,
          coin_price_uzs: '10000',
          amount_uzs: '10000',
          status: 'paid',
        })
        .execute(),
    ).rejects.toThrow(/payment_orders_paid_is_traceable/);
  });

  it('refuses two orders claiming one provider transaction (BR-19)', async () => {
    const first = await orderFor('payme', 1);
    const second = await orderFor('payme', 1);
    const shared = `shared-ptx-${first.orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: shared,
        amount: first.amountUzs * 100,
        account: paymeAccount(first.orderId),
      }),
    );

    await expect(
      db
        .updateTable('payment_orders')
        .set({ provider_transaction_id: shared })
        .where('id', '=', second.orderId)
        .execute(),
    ).rejects.toThrow(/payment_orders_provider_transaction_idx/);
  });

  it('answers a reused transaction id with a provider error, not a crash', async () => {
    // Found by this suite leaving its rows behind: the unique index above would refuse the
    // update as a raw database error thrown out of the transaction, which would roll back the
    // event row explaining it and answer Payme with a 500. The collision is read first, so
    // the provider gets a code it understands and the trail keeps the reason.
    const first = await orderFor('payme', 1);
    const second = await orderFor('payme', 1);
    const shared = `reused-ptx-${first.orderId}`;

    await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: shared,
        amount: first.amountUzs * 100,
        account: paymeAccount(first.orderId),
      }),
    );

    const response = (await orders.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: shared,
        amount: second.amountUzs * 100,
        account: paymeAccount(second.orderId),
      }),
    )) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-31008);
    expect(await statusOf(second.orderId)).toBe('created');
    expect((await eventsFor(second.orderId)).map((e) => e.detail)).toEqual([
      'transaction_claimed_by_another_order',
    ]);
  });
});

async function countEvents(): Promise<number> {
  const row = await sql<{ count: string }>`
    SELECT count(*) AS count FROM payment_events
  `.execute(db);

  return Number(row.rows[0]?.count ?? 0);
}
