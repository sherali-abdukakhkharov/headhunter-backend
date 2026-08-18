import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@infra/env-schema';

import { ClickProvider } from './click.provider';
import type { CommandOutcome, OrderSnapshot } from './payment-provider';
import { PaymeProvider, fromTiyin, toTiyin } from './payme.provider';

/**
 * The two provider adapters, without a database (§6.7, §12.6).
 *
 * These are the parts of M13 that are pure and hostile: a signature check, a factor of 100,
 * and two wire formats that answer the same questions with different words. All of it is
 * testable without Postgres, and all of it is the kind of code that is wrong in a way no
 * integration test would localize - a failing signature and a wrong amount both surface as
 * "the payment did not credit".
 *
 * The state machine and everything about exactly-once crediting is in
 * `payments.int.spec.ts`, because those are database guarantees.
 */

const PAYME_KEY = 'test-payme-merchant-key';
const CLICK_SECRET = 'test-click-secret';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';

function paymeConfig(configured = true): ConfigService<AppEnv, true> {
  return {
    get: (key: string) =>
      ({
        PAYME_MERCHANT_ID: configured ? 'merchant-1' : '',
        PAYME_MERCHANT_KEY: configured ? PAYME_KEY : '',
        PAYME_CHECKOUT_URL: 'https://checkout.paycom.uz',
        PAYME_ACCOUNT_FIELD: 'order_id',
      })[key],
  } as unknown as ConfigService<AppEnv, true>;
}

function clickConfig(configured = true): ConfigService<AppEnv, true> {
  return {
    get: (key: string) =>
      ({
        CLICK_MERCHANT_ID: configured ? 'merchant-9' : '',
        CLICK_SERVICE_ID: configured ? 'service-7' : '',
        CLICK_SECRET_KEY: configured ? CLICK_SECRET : '',
        CLICK_MERCHANT_USER_ID: '',
        CLICK_CHECKOUT_URL: 'https://my.click.uz/services/pay',
      })[key],
  } as unknown as ConfigService<AppEnv, true>;
}

/** Payme's Basic credential: the fixed username, and the merchant key as the password. */
function basic(key: string): string {
  return `Basic ${Buffer.from(`Paycom:${key}`, 'utf8').toString('base64')}`;
}

function snapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: ORDER_ID,
    status: 'pending',
    coins: 10,
    amountUzs: 100_000,
    providerTransactionId: 'ptx-1',
    createdAtMs: 1_700_000_000_000,
    paidAtMs: null,
    updatedAtMs: 1_700_000_001_000,
    ...overrides,
  };
}

describe('Payme amounts are in tiyin (§12.6)', () => {
  it('converts both ways without drift', () => {
    // The single most likely place in this milestone to be wrong by two orders of
    // magnitude, so both directions are pinned rather than assumed symmetric.
    expect(toTiyin(100_000)).toBe(10_000_000);
    expect(fromTiyin(10_000_000)).toBe(100_000);
    expect(fromTiyin(toTiyin(12_345.67))).toBeCloseTo(12_345.67, 2);
  });

  it('rounds rather than truncating a numeric(14,2) that arrives imprecise', () => {
    // 0.1 + 0.2 arithmetic upstream must not become 1 tiyin less than it should be.
    expect(toTiyin(0.29)).toBe(29);
    expect(toTiyin(1234.005)).toBe(123_401);
  });
});

describe('the Payme checkout link (§6.7)', () => {
  it('carries the merchant, the account and the amount in tiyin, and no secret', () => {
    const url = new PaymeProvider(paymeConfig()).checkout({
      id: ORDER_ID,
      coins: 10,
      amountUzs: 100_000,
      locale: 'ru',
    }).url;

    const encoded = url.slice('https://checkout.paycom.uz/'.length);
    const params = Buffer.from(encoded, 'base64').toString('utf8');

    expect(params).toBe(`m=merchant-1;ac.order_id=${ORDER_ID};a=10000000;l=ru`);
    // BR-22: nothing a client can see may carry a provider credential.
    expect(url).not.toContain(PAYME_KEY);
  });
});

describe('Payme callback verification (§12.6)', () => {
  const payme = new PaymeProvider(paymeConfig());

  const check = {
    method: 'CheckPerformTransaction',
    id: 42,
    params: { amount: 10_000_000, account: { order_id: ORDER_ID } },
  };

  it('accepts the documented Basic credential', () => {
    const parsed = payme.parse({
      headers: { authorization: basic(PAYME_KEY) },
      body: check,
    });

    expect(parsed).toEqual({
      verified: true,
      method: 'CheckPerformTransaction',
      requestId: 42,
      // Converted to soum on the way in, so nothing downstream handles tiyin.
      command: { kind: 'check', orderId: ORDER_ID, amountUzs: 100_000 },
    });
  });

  it.each([
    ['no header at all', undefined],
    ['a bearer token', 'Bearer some-token'],
    ['the wrong key', basic('wrong-key')],
    [
      'the right key under the wrong username',
      `Basic ${Buffer.from(`Admin:${PAYME_KEY}`).toString('base64')}`,
    ],
    ['a key that is a prefix of the real one', basic(PAYME_KEY.slice(0, 10))],
  ])('refuses %s', (_case, authorization) => {
    const parsed = payme.parse({ headers: { authorization }, body: check });

    expect(parsed.verified).toBe(false);
    expect(parsed).toMatchObject({ detail: 'invalid_signature' });
  });

  it('refuses everything when no merchant account is configured', () => {
    // The `LoggingSmsSender` rule: with no credential there is nothing to verify against,
    // so there is no code path that returns a verified command.
    const unconfigured = new PaymeProvider(paymeConfig(false));

    const parsed = unconfigured.parse({
      headers: { authorization: basic('') },
      body: check,
    });

    expect(parsed).toMatchObject({
      verified: false,
      detail: 'provider_not_configured',
    });
  });

  it('maps all six §12.6 methods, and refuses a seventh', () => {
    const headers = { authorization: basic(PAYME_KEY) };
    const parse = (body: unknown) => payme.parse({ headers, body });

    expect(
      parse({
        method: 'CreateTransaction',
        params: {
          id: 'ptx-1',
          amount: 10_000_000,
          account: { order_id: ORDER_ID },
        },
      }),
    ).toMatchObject({
      verified: true,
      command: {
        kind: 'create',
        orderId: ORDER_ID,
        amountUzs: 100_000,
        providerTransactionId: 'ptx-1',
      },
    });

    expect(
      parse({ method: 'PerformTransaction', params: { id: 'ptx-1' } }),
    ).toMatchObject({
      verified: true,
      // Payme sends neither the account nor the amount here, so neither is invented.
      command: {
        kind: 'perform',
        providerTransactionId: 'ptx-1',
        orderId: null,
        amountUzs: null,
      },
    });

    expect(
      parse({
        method: 'CancelTransaction',
        params: { id: 'ptx-1', reason: 5 },
      }),
    ).toMatchObject({
      verified: true,
      command: { kind: 'cancel', providerTransactionId: 'ptx-1', reason: '5' },
    });

    expect(
      parse({ method: 'CheckTransaction', params: { id: 'ptx-1' } }),
    ).toMatchObject({
      verified: true,
      command: { kind: 'status', providerTransactionId: 'ptx-1' },
    });

    expect(
      parse({ method: 'GetStatement', params: { from: 1, to: 2 } }),
    ).toMatchObject({
      verified: true,
      command: { kind: 'statement', fromMs: 1, toMs: 2 },
    });

    expect(parse({ method: 'DoSomethingElse', params: {} })).toMatchObject({
      verified: false,
      detail: 'unknown_method',
    });
  });

  it('treats a method with missing parameters as malformed, not as a command', () => {
    const parsed = payme.parse({
      headers: { authorization: basic(PAYME_KEY) },
      // Authenticated, and still unusable: no account and no amount.
      body: { method: 'CheckPerformTransaction', params: {} },
    });

    expect(parsed).toMatchObject({
      verified: false,
      detail: 'malformed_request',
    });
  });

  it('does not choke on an order id that is not a UUID', () => {
    // A provider can send anything at all in its account field. Parsing must survive it;
    // the service is what decides it names no order.
    const parsed = payme.parse({
      headers: { authorization: basic(PAYME_KEY) },
      body: {
        method: 'CheckPerformTransaction',
        params: { amount: 1, account: { order_id: "'; DROP TABLE users; --" } },
      },
    });

    expect(parsed).toMatchObject({ verified: true });
  });
});

describe('Payme responses (§12.6)', () => {
  const payme = new PaymeProvider(paymeConfig());
  const callback = {
    verified: true as const,
    method: 'PerformTransaction',
    requestId: 7,
    command: {
      kind: 'perform' as const,
      providerTransactionId: 'ptx-1',
      orderId: null,
      amountUzs: null,
    },
  };

  it('sends no fiscal receipt while the attributes are unknown (§6.7)', () => {
    // §6.7 assigns the service/product code and VAT to the client's accounting function, and
    // `payment-fiscal.ts` declares them as unsupplied. A receipt built from a placeholder tax
    // code would end up on a real transaction, so the field is absent rather than guessed.
    const response = payme.render(
      { ...callback, method: 'CheckPerformTransaction' },
      { ok: true, kind: 'check', order: snapshot() },
    ) as { body: { result: Record<string, unknown> } };

    expect(response.body.result).toEqual({ allow: true });
    expect(response.body.result).not.toHaveProperty('detail');
  });

  it('echoes the JSON-RPC id and reports state 2 for a performed transaction', () => {
    const response = payme.render(callback, {
      ok: true,
      kind: 'performed',
      order: snapshot({ status: 'paid', paidAtMs: 1_700_000_002_000 }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 7,
      result: {
        transaction: ORDER_ID,
        perform_time: 1_700_000_002_000,
        state: 2,
      },
    });
  });

  it('distinguishes a cancellation before payment from a refund after it', () => {
    const before = payme.render(callback, {
      ok: true,
      kind: 'cancelled',
      order: snapshot({ status: 'cancelled' }),
    }) as { body: { result: { state: number } } };

    const after = payme.render(callback, {
      ok: true,
      kind: 'cancelled',
      order: snapshot({ status: 'reversed', paidAtMs: 1 }),
    }) as { body: { result: { state: number } } };

    // -1 and -2 are a distinction Payme makes and our single `reversed` status carries.
    expect(before.body.result.state).toBe(-1);
    expect(after.body.result.state).toBe(-2);
  });

  it('answers a business refusal with 200 and Payme’s own error code', () => {
    // 200, because an HTTP error makes a provider retry a request already decided.
    const cases: [CommandOutcome, number][] = [
      [{ ok: false, code: 'invalid_amount' }, -31001],
      [{ ok: false, code: 'transaction_not_found' }, -31003],
      [{ ok: false, code: 'order_not_payable' }, -31008],
      [{ ok: false, code: 'order_not_found' }, -31050],
    ];

    for (const [outcome, code] of cases) {
      const response = payme.render(callback, outcome) as {
        status: number;
        body: { error: { code: number; message: Record<string, string> } };
      };

      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(code);
      // Payme's envelope requires all three, and they are protocol strings rather than
      // anything a person reads - nothing here consults `x-lang`.
      expect(Object.keys(response.body.error.message).sort()).toEqual([
        'en',
        'ru',
        'uz',
      ]);
    }
  });

  it('answers a failed authentication without saying whether the order exists', () => {
    const response = payme.renderRejection({
      verified: false,
      method: 'PerformTransaction',
      requestId: 9,
      detail: 'invalid_signature',
    }) as { body: { error: { code: number } } };

    expect(response.body.error.code).toBe(-32504);
  });
});

describe('the CLICK checkout link (§6.7)', () => {
  it('carries the service, the merchant and the order, and no secret', () => {
    const url = new ClickProvider(clickConfig()).checkout({
      id: ORDER_ID,
      coins: 10,
      amountUzs: 100_000,
      locale: 'uz-Latn',
    }).url;

    const query = new URL(url).searchParams;

    expect(query.get('service_id')).toBe('service-7');
    expect(query.get('merchant_id')).toBe('merchant-9');
    expect(query.get('amount')).toBe('100000.00');
    expect(query.get('transaction_param')).toBe(ORDER_ID);
    expect(url).not.toContain(CLICK_SECRET);
  });
});

describe('CLICK callback verification (§12.6)', () => {
  const click = new ClickProvider(clickConfig());

  /** CLICK's documented sign string, rebuilt here rather than borrowed from the adapter. */
  function sign(parts: (string | number)[]): string {
    return createHash('md5').update(parts.join(''), 'utf8').digest('hex');
  }

  function prepare(overrides: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = {
      click_trans_id: '900001',
      service_id: 'service-7',
      merchant_trans_id: ORDER_ID,
      amount: '100000.00',
      action: '0',
      error: '0',
      sign_time: '2026-08-18 12:00:00',
      ...overrides,
    };

    body.sign_string ??= sign([
      body.click_trans_id as string,
      'service-7',
      CLICK_SECRET,
      body.merchant_trans_id as string,
      body.amount as string,
      body.action as string,
      body.sign_time as string,
    ]);

    return body;
  }

  it('accepts a correctly signed Prepare', () => {
    const parsed = click.parse({ headers: {}, body: prepare() });

    expect(parsed).toEqual({
      verified: true,
      method: 'Prepare',
      // CLICK is not JSON-RPC and has nothing to echo.
      requestId: null,
      command: {
        kind: 'create',
        orderId: ORDER_ID,
        amountUzs: 100_000,
        providerTransactionId: '900001',
      },
    });
  });

  it('refuses a Prepare signed with the wrong secret', () => {
    const parsed = click.parse({
      headers: {},
      body: prepare({
        sign_string: sign([
          '900001',
          'service-7',
          'not-the-secret',
          ORDER_ID,
          '100000.00',
          '0',
          '2026-08-18 12:00:00',
        ]),
      }),
    });

    expect(parsed).toMatchObject({
      verified: false,
      detail: 'invalid_signature',
    });
  });

  it('refuses a request signed for a different service (§12.6’s merchant parameters)', () => {
    // A valid signature over the wrong service id is still not our transaction, so the
    // signature alone is not the whole check.
    const body = prepare({ service_id: 'someone-elses-service' });
    body.sign_string = sign([
      '900001',
      'someone-elses-service',
      CLICK_SECRET,
      ORDER_ID,
      '100000.00',
      '0',
      '2026-08-18 12:00:00',
    ]);

    expect(click.parse({ headers: {}, body })).toMatchObject({
      verified: false,
      detail: 'invalid_signature',
    });
  });

  /**
   * The `merchant_prepare_id` CLICK was handed, taken from a rendered `Prepare` response.
   *
   * Read from the response rather than recomputed, because that is the actual contract: the
   * value CLICK signs on `Complete` is whatever `Prepare` gave it. A test that derived it
   * independently could keep passing while the two halves disagreed.
   */
  function issuedPrepareId(): string {
    const parsed = click.parse({ headers: {}, body: prepare() });

    if (!parsed.verified) {
      throw new Error('the Prepare fixture must verify');
    }

    const response = click.render(parsed, {
      ok: true,
      kind: 'created',
      order: snapshot(),
    }) as { body: { merchant_prepare_id?: string } };

    const prepareId = response.body.merchant_prepare_id;

    if (prepareId === undefined) {
      throw new Error('Prepare must answer with a merchant_prepare_id');
    }

    return prepareId;
  }

  /** A `Complete`, signed over CLICK's field order including `merchant_prepare_id`. */
  function complete(overrides: Record<string, unknown> = {}) {
    const prepareId = issuedPrepareId();
    const body: Record<string, unknown> = {
      click_trans_id: '900001',
      service_id: 'service-7',
      merchant_trans_id: ORDER_ID,
      merchant_prepare_id: prepareId,
      amount: '100000.00',
      action: '1',
      error: '0',
      sign_time: '2026-08-18 12:30:00',
      ...overrides,
    };

    body.sign_string ??= sign([
      body.click_trans_id as string,
      'service-7',
      CLICK_SECRET,
      body.merchant_trans_id as string,
      body.merchant_prepare_id as string,
      body.amount as string,
      body.action as string,
      body.sign_time as string,
    ]);

    return body;
  }

  it('signs a Complete over merchant_prepare_id, which Prepare handed out', () => {
    expect(click.parse({ headers: {}, body: complete() })).toMatchObject({
      verified: true,
      method: 'Complete',
      command: {
        kind: 'perform',
        providerTransactionId: '900001',
        // Unlike Payme, CLICK re-sends both, so the service re-checks both.
        orderId: ORDER_ID,
        amountUzs: 100_000,
      },
    });
  });

  it('refuses a Complete naming a merchant_prepare_id it was never given', () => {
    // Verification precedes interpretation (§12.6): a completion this API cannot match to a
    // preparation it issued is refused before the order is looked at.
    expect(
      click.parse({
        headers: {},
        body: complete({ merchant_prepare_id: '1' }),
      }),
    ).toMatchObject({ verified: false, detail: 'malformed_request' });
  });

  it('reads a Complete carrying CLICK’s own error as a cancellation, never a credit', () => {
    // BR-20: a failed or cancelled payment must not reach the credit path at all, so this is
    // a `cancel` command rather than a `perform` the service would then have to refuse.
    const body = complete({
      error: '-31',
      error_note: 'Payment cancelled by user',
    });

    expect(click.parse({ headers: {}, body })).toMatchObject({
      verified: true,
      command: {
        kind: 'cancel',
        providerTransactionId: '900001',
        orderId: ORDER_ID,
        reason: 'Payment cancelled by user',
      },
    });
  });

  it('refuses an action that is neither Prepare nor Complete', () => {
    expect(
      click.parse({ headers: {}, body: prepare({ action: '7' }) }),
    ).toMatchObject({ verified: false, detail: 'unknown_method' });
  });

  it('refuses everything when no merchant account is configured', () => {
    expect(
      new ClickProvider(clickConfig(false)).parse({
        headers: {},
        body: prepare(),
      }),
    ).toMatchObject({ verified: false, detail: 'provider_not_configured' });
  });

  it('answers a refusal with 200 and CLICK’s own error integer', () => {
    const callback = {
      verified: true as const,
      method: 'Complete',
      requestId: null,
      command: {
        kind: 'perform' as const,
        providerTransactionId: '900001',
        orderId: ORDER_ID,
        amountUzs: 100_000,
      },
    };

    const response = click.render(callback, {
      ok: false,
      code: 'invalid_amount',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      error: -2,
      error_note: 'Incorrect amount',
    });
  });

  it('answers a bad signature with CLICK’s SIGN CHECK FAILED', () => {
    const response = click.renderRejection({
      verified: false,
      method: 'Prepare',
      requestId: null,
      detail: 'invalid_signature',
    });

    expect(response.body).toEqual({
      error: -1,
      error_note: 'SIGN CHECK FAILED',
    });
  });
});
