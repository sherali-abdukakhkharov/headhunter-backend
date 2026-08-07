import { parseServiceAccount } from './fcm-push.sender';
import { NoopPushSender } from './noop-push.sender';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

/**
 * The two halves of the push seam that can be checked without a network.
 *
 * The FCM sender's own behaviour cannot be: it is an HTTPS call to Google. What *is*
 * worth pinning here is the credential parsing, because it decides whether a
 * misconfigured deployment fails at boot or at the first notification, and the no-op
 * sender's refusal to claim success.
 */
describe('parseServiceAccount', () => {
  it('reads a well-formed credential', () => {
    const account = parseServiceAccount(
      encode({
        project_id: 'headhunter-uz',
        client_email: 'fcm@headhunter-uz.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
      }),
    );

    expect(account.project_id).toBe('headhunter-uz');
  });

  it('refuses something that is not base64 JSON', () => {
    expect(() => parseServiceAccount('not base64 at all')).toThrow(
      /not base64-encoded JSON/,
    );
  });

  it.each([
    ['project_id', { client_email: 'a@b.c', private_key: 'k' }],
    ['client_email', { project_id: 'p', private_key: 'k' }],
    ['private_key', { project_id: 'p', client_email: 'a@b.c' }],
  ])('refuses a credential missing %s', (_field, value) => {
    // At construction, so a deployment with half a credential fails at boot rather than
    // silently dropping every notification.
    expect(() => parseServiceAccount(encode(value))).toThrow(/missing/);
  });
});

describe('NoopPushSender', () => {
  it('reports failure rather than pretending to have sent', async () => {
    const results = await new NoopPushSender().send([
      {
        token: 'device-1',
        title: 'x',
        body: 'y',
        data: {},
        locale: 'ru',
      },
    ]);

    // The whole point of the no-op: a sender that answered `sent` would train everybody
    // to believe delivery works, and would hide a missing credential behind clean logs.
    expect(results).toEqual([
      { token: 'device-1', status: 'failed', error: 'push_not_configured' },
    ]);
  });

  it('says nothing about tokens it was not given', async () => {
    expect(await new NoopPushSender().send([])).toEqual([]);
  });
});
