import { ConfigService } from '@nestjs/config';

import { ReleaseNotifierService, rankOf } from './release-notifier.service';

/**
 * The release poster, and the two things it must never get wrong: **sending the
 * same build twice**, and **taking the API down when GitHub or Telegram is
 * having a bad day**.
 *
 * Both are about a timer nobody is watching. A duplicate is a phone that
 * downloads 23 MB for nothing; an uncaught throw in an interval callback is an
 * unhandled rejection in a running server.
 */
describe('rankOf', () => {
  it('orders releases the way a person would', () => {
    expect(rankOf('1.33.0')!).toBeGreaterThan(rankOf('1.32.0')!);
    expect(rankOf('2.0.0')!).toBeGreaterThan(rankOf('1.99.99')!);
    expect(rankOf('1.33.1')!).toBeGreaterThan(rankOf('1.33.0')!);
  });

  it('is not string ordering, which is the whole reason it exists', () => {
    // '1.9.0' > '1.10.0' as text. A tag comparison would have sent 1.10.0 and
    // then refused everything after it.
    expect(rankOf('1.10.0')!).toBeGreaterThan(rankOf('1.9.0')!);
  });

  it('refuses anything that is not three numbers', () => {
    for (const bad of ['v1.33.0', '1.33', '1.33.0-rc1', 'latest', '']) {
      expect(rankOf(bad)).toBeNull();
    }
  });
});

describe('ReleaseNotifierService', () => {
  const release = {
    tag_name: 'v1.34.0',
    html_url: 'https://example.test/releases/v1.34.0',
    assets: [
      {
        name: 'jobbridge-1.34.0-arm64.apk',
        browser_download_url: 'https://example.test/apk',
        size: 23_000_000,
      },
      {
        name: 'notes-uz.txt',
        browser_download_url: 'https://example.test/notes',
        size: 200,
      },
    ],
  };

  /** Whatever the settings table currently holds, as a number or null. */
  let stored: number | null;
  let inserted: number[];

  function db() {
    return {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () =>
              Promise.resolve(
                stored === null ? undefined : { value_int: stored },
              ),
          }),
        }),
      }),
      insertInto: () => ({
        values: (row: { value_int: number }) => ({
          onConflict: () => ({
            execute: () => {
              inserted.push(row.value_int);
              stored = row.value_int;

              return Promise.resolve();
            },
          }),
        }),
      }),
    };
  }

  function config(chatId = '-100999') {
    return {
      get: (key: string) =>
        ({
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_API_BASE_URL: 'https://telegram.test',
          RELEASE_TIMEOUT_MS: 1000,
          RELEASE_CHAT_ID: chatId,
          RELEASE_REPO: 'owner/repo',
          RELEASE_POLL_MINUTES: 10,
        })[key],
    } as unknown as ConfigService<never, true>;
  }

  function service(chatId?: string) {
    // The stub implements the three calls this service makes and nothing
    // else, which is the point: a real Kysely instance here would be testing
    // Kysely.
    return new ReleaseNotifierService(
      db() as unknown as ConstructorParameters<
        typeof ReleaseNotifierService
      >[0],
      config(chatId),
    );
  }

  let calls: string[];

  beforeEach(() => {
    stored = null;
    inserted = [];
    calls = [];

    globalThis.fetch = ((url: string | URL) => {
      const href = url.toString();
      calls.push(href);

      if (href.includes('api.github.com')) {
        return Promise.resolve(
          new Response(JSON.stringify(release), { status: 200 }),
        );
      }
      if (href.includes('/notes')) {
        return Promise.resolve(new Response('- Yangi rasm bor.'));
      }
      if (href.includes('/apk')) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      }

      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }) as typeof fetch;
  });

  it('sends a release it has not sent before', async () => {
    await service().check();

    expect(calls.some((c) => c.includes('/sendDocument'))).toBe(true);
    expect(inserted).toEqual([rankOf('1.34.0')]);
  });

  it('and does not send it again', async () => {
    const notifier = service();

    await notifier.check();
    calls = [];
    await notifier.check();

    expect(calls.some((c) => c.includes('/sendDocument'))).toBe(false);
  });

  it('records nothing when Telegram refuses, so the next tick retries', async () => {
    globalThis.fetch = ((url: string | URL) => {
      const href = url.toString();
      if (href.includes('api.github.com')) {
        return Promise.resolve(
          new Response(JSON.stringify(release), { status: 200 }),
        );
      }
      if (href.includes('/notes') || href.includes('/apk')) {
        return Promise.resolve(new Response('x'));
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, description: 'chat not found' }),
          { status: 400 },
        ),
      );
    }) as typeof fetch;

    await service().check();

    expect(inserted).toEqual([]);
  });

  it('does nothing at all without a chat id', async () => {
    await service('').check();

    expect(calls).toEqual([]);
  });

  it('survives GitHub being unreachable', async () => {
    globalThis.fetch = () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };

    // An interval callback that throws is an unhandled rejection in a running
    // server, and this one runs every ten minutes forever.
    await expect(service().check()).resolves.toBeUndefined();
    expect(inserted).toEqual([]);
  });

  it('waits rather than sending a release with no APK on it', async () => {
    globalThis.fetch = ((url: string | URL) => {
      const href = url.toString();
      if (href.includes('api.github.com')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...release, assets: [] })),
        );
      }

      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }) as typeof fetch;

    await service().check();

    // Ordinary for a minute while a workflow uploads, and permanent if a run
    // died after tagging. Recording it would mean never sending that version.
    expect(inserted).toEqual([]);
  });
});
