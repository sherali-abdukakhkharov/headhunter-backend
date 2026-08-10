import type { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@infra/env-schema';
import { MESSAGES } from '@infra/i18n/messages';
import { translate } from '@infra/i18n/translate';

import { EskizSmsSender } from './eskiz-sms.sender';
import { LoggingSmsSender } from './logging-sms.sender';
import type { SmsMessage } from './sms-sender';

/**
 * The SMS seam, without an Eskiz account.
 *
 * There is no account to test against, so what these pin is everything that *can* be
 * true before one exists: that the no-op never claims a delivery, that the message text
 * exists in four variants and carries the code, and that the provider client's error
 * classification and token handling behave as written. `fetch` is stubbed - this is a
 * test of the client's decisions, not of Eskiz.
 */

const message: SmsMessage = {
  phone: '+998901234567',
  text: 'Universal HeadHunter: kirish kodi 123456.',
  locale: 'uz-Latn',
};

function config(overrides: Partial<AppEnv> = {}) {
  const values: Record<string, unknown> = {
    ESKIZ_BASE_URL: 'https://notify.example.test',
    ESKIZ_EMAIL: 'ops@example.test',
    ESKIZ_PASSWORD: 'secret',
    ESKIZ_FROM: '4546',
    ESKIZ_TIMEOUT_MS: 5000,
    ...overrides,
  };

  return { get: (key: string) => values[key] } as unknown as ConfigService<
    AppEnv,
    true
  >;
}

/** A `fetch` that answers a queue of responses and records what it was asked. */
function stubFetch(responses: { status: number; body: string }[]) {
  const calls: { url: string; body: string }[] = [];

  const fetchStub = jest.fn((url: string | URL, init?: RequestInit) => {
    const next = responses.shift() ?? { status: 500, body: '' };

    // `URLSearchParams` stringifies to the encoded body, which is what these tests read;
    // anything else would be `[object Object]`, so it is narrowed rather than coerced.
    const body = init?.body;

    calls.push({
      url: String(url),
      body: body instanceof URLSearchParams ? body.toString() : '',
    });

    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: () => Promise.resolve(next.body),
    } as Response);
  });

  global.fetch = fetchStub as unknown as typeof fetch;

  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the message text (§3.2, §4.1)', () => {
  it('exists in all four variants and carries the code in each', () => {
    const entry = MESSAGES['sms.otp_code'];

    for (const locale of ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const) {
      // A placeholder present in one language and missing in another renders as literal
      // braces to that user - and on this message it would mean an SMS with no code.
      expect(entry[locale]).toContain('{code}');
      expect(translate('sms.otp_code', locale, { code: '123456' })).toContain(
        '123456',
      );
    }
  });

  it('stays inside one Cyrillic SMS segment', () => {
    // A Cyrillic SMS is 70 characters per segment, not 160. Two segments is twice the
    // price for every login on the platform, so the ceiling is worth asserting rather
    // than discovering on an invoice.
    const rendered = translate('sms.otp_code', 'uz-Cyrl', { code: '123456' });

    expect(rendered.length).toBeLessThanOrEqual(70);
  });
});

describe('LoggingSmsSender', () => {
  it('reports failure, never success', async () => {
    // The same rule the no-op push sender follows. A no-op that claimed `sent` would put
    // "delivered" in the log for a code nobody received.
    await expect(new LoggingSmsSender().send(message)).resolves.toEqual({
      status: 'failed',
      error: 'sms_not_configured',
    });
  });
});

describe('EskizSmsSender', () => {
  it('logs in once and reuses the token across sends', async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'tok' } }) },
      { status: 200, body: JSON.stringify({ id: 42 }) },
      { status: 200, body: JSON.stringify({ id: 43 }) },
    ]);

    const sender = new EskizSmsSender(config());

    expect(await sender.send(message)).toEqual({
      status: 'sent',
      providerMessageId: '42',
    });
    expect(await sender.send(message)).toMatchObject({ status: 'sent' });

    // Three calls, not four: minting a token per message would add a round trip to the
    // provider on every login.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain('/api/auth/login');
    expect(calls[1]?.url).toContain('/api/message/sms/send');
  });

  it('sends the number without its plus, and the configured originator', async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'tok' } }) },
      { status: 200, body: '{}' },
    ]);

    await new EskizSmsSender(config()).send(message);

    expect(calls[1]?.body).toContain('mobile_phone=998901234567');
    expect(calls[1]?.body).toContain('from=4546');
  });

  it('re-authenticates once on a 401 and sends again', async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'stale' } }) },
      { status: 401, body: 'expired' },
      { status: 200, body: JSON.stringify({ data: { token: 'fresh' } }) },
      { status: 200, body: JSON.stringify({ id: 7 }) },
    ]);

    // A token that expired mid-flight must not become a user-visible login failure.
    expect(await new EskizSmsSender(config()).send(message)).toMatchObject({
      status: 'sent',
    });
    expect(calls).toHaveLength(4);
  });

  it('gives up after one re-authentication, rather than looping', async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'a' } }) },
      { status: 401, body: 'expired' },
      { status: 200, body: JSON.stringify({ data: { token: 'b' } }) },
      { status: 401, body: 'expired again' },
    ]);

    // Looping against an account whose password is wrong is how an account gets locked.
    expect(await new EskizSmsSender(config()).send(message)).toMatchObject({
      status: 'failed',
    });
    expect(calls).toHaveLength(4);
  });

  it('names an unapproved template, because the fix is not in this codebase', async () => {
    stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'tok' } }) },
      { status: 400, body: '{"message":"template not found"}' },
    ]);

    // A fresh Eskiz account accepts only three exact test strings until a template is
    // approved, and that is the single most likely first failure on connection day.
    expect(await new EskizSmsSender(config()).send(message)).toEqual({
      status: 'failed',
      error: 'sms_template_not_approved',
    });
  });

  it('fails without throwing when the provider is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ETIMEDOUT')));

    // The caller turns this into a localized error and removes the code; an unhandled
    // rejection here would surface as a 500 with an internal message.
    expect(await new EskizSmsSender(config()).send(message)).toEqual({
      status: 'failed',
      error: 'sms_transport_failed',
    });
  });

  it('fails when login answers no token, rather than sending with none', async () => {
    stubFetch([{ status: 200, body: '{"data":{}}' }]);

    expect(await new EskizSmsSender(config()).send(message)).toMatchObject({
      status: 'failed',
      error: 'sms_transport_failed',
    });
  });

  it('never puts the provider’s prose in the result', async () => {
    stubFetch([
      { status: 200, body: JSON.stringify({ data: { token: 'tok' } }) },
      { status: 422, body: 'balance exhausted for account ops@example.test' },
    ]);

    const result = await new EskizSmsSender(config()).send(message);

    // The account's own email came back in that body. The client gets a code.
    expect(result.error).toBe('sms_rejected_422');
    expect(JSON.stringify(result)).not.toContain('example.test');
  });
});
