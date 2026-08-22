import { randomUUID } from 'node:crypto';

import { ForbiddenError } from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';

import { DevicesService } from './devices.service';
import { NotificationsService } from './notifications.service';
import { PushDispatcher } from './push/push-dispatcher.service';
import type { PushMessage, PushResult } from './push/push-sender';
import { PushSender } from './push/push-sender';

/**
 * §9.2's notifications against a real Postgres.
 *
 * The test this file exists for is the language one: a notification stores a message key
 * and its parameters, and the row is rendered in the reader's *current* language. Every
 * other design here follows from that, and none of it can be checked without a database -
 * the preference gate is a query, the always-on category is a CHECK constraint, and the
 * unread badge is an aggregate.
 *
 * The nine events reaching the right recipients are covered where they are *emitted*: the
 * applications, invitations, chat, interviews and admin suites each construct the real
 * notifications service, so a wiring mistake fails there rather than being asserted twice.
 */

/** A sender that reports whatever the test needs, so the dispatcher can be exercised. */
class StubSender extends PushSender {
  sent: PushMessage[] = [];
  outcome: PushResult['status'] = 'sent';

  send(messages: PushMessage[]): Promise<PushResult[]> {
    this.sent.push(...messages);

    return Promise.resolve(
      messages.map((message) => ({
        token: message.token,
        status: this.outcome,
      })),
    );
  }
}

let db: Database;
let destroy: () => Promise<void>;
let notifications: NotificationsService;
let devices: DevicesService;
let sender: StubSender;

const users: string[] = [];

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());

  sender = new StubSender();
  notifications = new NotificationsService(db, new PushDispatcher(db, sender));
  devices = new DevicesService(db);
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function newUser(
  locale: 'uz-Latn' | 'ru' | 'en' = 'uz-Latn',
): Promise<string> {
  const phone = fixturePhone();
  const row = await db
    .insertInto('users')
    .values({ phone, locale })
    .returning('id')
    .executeTakeFirstOrThrow();

  users.push(row.id);

  return row.id;
}

describe('a notification is stored as a key, not as text', () => {
  it('renders in the language of the request, not of the event', async () => {
    const userId = await newUser('uz-Latn');
    await notifications.notify({
      userId,
      event: 'application_created',
      params: { vacancy: 'Backend developer' },
    });

    const inUzbek = await notifications.list(userId, 'uz-Latn', {}, 10, 0);
    const inRussian = await notifications.list(userId, 'ru', {}, 10, 0);
    const inEnglish = await notifications.list(userId, 'en', {}, 10, 0);

    // One row, three languages. Rendering at write time would have frozen this list in
    // whatever language the reader used when the event happened (§3.2).
    expect(inUzbek[0].text).toContain('Backend developer');
    expect(inRussian[0].text).toContain('Новый отклик');
    expect(inEnglish[0].text).toContain('A new application');
    expect(inRussian[0].id).toBe(inUzbek[0].id);
  });

  it('leaves a missing parameter visible rather than blanking it', async () => {
    const userId = await newUser();
    await notifications.notify({ userId, event: 'application_created' });

    const [item] = await notifications.list(userId, 'en', {}, 10, 0);

    // `translate` leaves an unmatched placeholder as-is on purpose, and this asserts that
    // notifications inherit it rather than quietly differing: a caller that forgot a
    // parameter is a bug, and blanking it would hide the bug from the only people who can
    // fix it while still showing the user a broken sentence. The call sites always pass
    // them, and `notification-events.spec.ts` pins which each event expects.
    expect(item.text).toContain('{vacancy}');
  });

  it('carries the deep link rather than expecting the client to parse the text', async () => {
    const userId = await newUser();
    const vacancyId = randomUUID();
    await notifications.notify({
      userId,
      event: 'application_created',
      params: { vacancy: 'Operator' },
      target: { type: 'vacancy', id: vacancyId },
    });

    const [item] = await notifications.list(userId, 'en', {}, 10, 0);

    expect(item).toMatchObject({ targetType: 'vacancy', targetId: vacancyId });
  });
});

describe('§9.2’s preferences', () => {
  it('stores nothing at all for a disabled category', async () => {
    const userId = await newUser();
    await notifications.setPreference(userId, 'messages', false);

    await notifications.notify({
      userId,
      event: 'message_received',
      params: { sender: 'Anvar' },
    });

    // Not a hidden row: a badge counting notifications the user asked not to receive
    // would be the same thing as not switching the category off.
    expect(await notifications.list(userId, 'en', {}, 10, 0)).toEqual([]);
    expect(await notifications.unreadCount(userId)).toBe(0);
  });

  it('still delivers the categories that stay on', async () => {
    const userId = await newUser();
    await notifications.setPreference(userId, 'messages', false);

    await notifications.notify({ userId, event: 'account_action' });

    expect(await notifications.list(userId, 'en', {}, 10, 0)).toHaveLength(1);
  });

  it('refuses to switch account notices off, in the service and in the database', async () => {
    const userId = await newUser();

    await expect(
      notifications.setPreference(userId, 'account', false),
    ).rejects.toThrow(ForbiddenError);

    // The same rule as a CHECK constraint, so no write path - including a manual fix -
    // can produce a user who is not told they have been restricted.
    await expect(
      db
        .insertInto('notification_preferences')
        .values({ user_id: userId, category: 'account', enabled: false })
        .execute(),
    ).rejects.toThrow(/notification_preferences_account_always_on/);
  });

  it('defaults to enabled, and reports which categories may be changed', async () => {
    const userId = await newUser();

    const preferences = await notifications.preferences(userId);

    expect(preferences).toEqual([
      { category: 'applications', enabled: true, canDisable: true },
      { category: 'interviews', enabled: true, canDisable: true },
      { category: 'invitations', enabled: true, canDisable: true },
      { category: 'messages', enabled: true, canDisable: true },
      // Listed rather than omitted: a user who cannot find it will assume it is off.
      { category: 'account', enabled: true, canDisable: false },
    ]);
  });

  it('switches a category back on', async () => {
    const userId = await newUser();
    await notifications.setPreference(userId, 'applications', false);
    await notifications.setPreference(userId, 'applications', true);

    await notifications.notify({
      userId,
      event: 'application_created',
      params: { vacancy: 'Operator' },
    });

    expect(await notifications.list(userId, 'en', {}, 10, 0)).toHaveLength(1);
  });
});

describe('the unread badge', () => {
  it('counts, marks one, and marks all', async () => {
    const userId = await newUser();
    await notifications.notify({ userId, event: 'account_action' });
    await notifications.notify({ userId, event: 'account_action' });
    await notifications.notify({ userId, event: 'account_action' });

    expect(await notifications.unreadCount(userId)).toBe(3);

    const [first] = await notifications.list(userId, 'en', {}, 10, 0);
    await notifications.markRead(userId, first.id);
    expect(await notifications.unreadCount(userId)).toBe(2);

    expect(await notifications.markAllRead(userId)).toBe(2);
    expect(await notifications.unreadCount(userId)).toBe(0);
  });

  it('filters to what has not been read', async () => {
    const userId = await newUser();
    await notifications.notify({ userId, event: 'account_action' });
    const [only] = await notifications.list(userId, 'en', {}, 10, 0);
    await notifications.markRead(userId, only.id);
    await notifications.notify({ userId, event: 'account_action' });

    const unread = await notifications.list(
      userId,
      'en',
      { unreadOnly: true },
      10,
      0,
    );

    expect(unread).toHaveLength(1);
    expect(unread[0].id).not.toBe(only.id);
  });

  it('never shows one user another’s notifications', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    await notifications.notify({ userId: owner, event: 'account_action' });

    expect(await notifications.list(stranger, 'en', {}, 10, 0)).toEqual([]);
    expect(await notifications.unreadCount(stranger)).toBe(0);
  });
});

describe('devices and dispatch', () => {
  it('pushes to every live device of the recipient, in their language', async () => {
    const userId = await newUser('ru');
    await devices.register(userId, {
      token: randomUUID(),
      platform: 'android',
    });
    await devices.register(userId, { token: randomUUID(), platform: 'ios' });
    sender.sent = [];

    await notifications.notify({
      userId,
      event: 'message_received',
      params: { sender: 'Anvar' },
    });
    // The dispatch is deliberately not awaited by `notify`, so give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0].body).toContain('отправил вам сообщение');
    expect(sender.sent[0].data).toMatchObject({ event: 'message_received' });
  });

  it('moves a token that is registered by a second account', async () => {
    const first = await newUser();
    const second = await newUser();
    const token = randomUUID();

    await devices.register(first, { token, platform: 'android' });
    await devices.register(second, { token, platform: 'android' });

    const row = await db
      .selectFrom('device_tokens')
      .select('user_id')
      .where('token', '=', token)
      .executeTakeFirstOrThrow();

    // A token belongs to an app installation, not to a person: phones here are handed on,
    // and two accounts claiming one would push somebody's interview times to a stranger.
    expect(row.user_id).toBe(second);
  });

  it('disables a token FCM reports as unregistered, and keeps the row', async () => {
    const userId = await newUser();
    const token = randomUUID();
    await devices.register(userId, { token, platform: 'android' });
    sender.outcome = 'invalid';

    await notifications.notify({ userId, event: 'account_action' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    sender.outcome = 'sent';

    const row = await db
      .selectFrom('device_tokens')
      .select('disabled_at')
      .where('token', '=', token)
      .executeTakeFirstOrThrow();

    // Disabled rather than deleted, so a reinstalled app is recognised and "this user has
    // no working device" stays answerable.
    expect(row.disabled_at).not.toBeNull();
  });

  it('re-enables it when the device registers again', async () => {
    const userId = await newUser();
    const token = randomUUID();
    await devices.register(userId, { token, platform: 'android' });
    await db
      .updateTable('device_tokens')
      .set({ disabled_at: new Date() })
      .where('token', '=', token)
      .execute();

    await devices.register(userId, { token, platform: 'android' });

    const row = await db
      .selectFrom('device_tokens')
      .select('disabled_at')
      .where('token', '=', token)
      .executeTakeFirstOrThrow();

    expect(row.disabled_at).toBeNull();
  });

  it('unregisters one device without touching the others', async () => {
    const userId = await newUser();
    const kept = randomUUID();
    const gone = randomUUID();
    await devices.register(userId, { token: kept, platform: 'android' });
    await devices.register(userId, { token: gone, platform: 'ios' });

    await devices.unregister(userId, gone);

    const rows = await db
      .selectFrom('device_tokens')
      .select('token')
      .where('user_id', '=', userId)
      .execute();

    expect(rows.map((row) => row.token)).toEqual([kept]);
  });

  it('records the notification even when there is no device to push to', async () => {
    const userId = await newUser();

    await notifications.notify({ userId, event: 'account_action' });

    // The in-app row is the record and push is an attempt on top of it (ARCHITECTURE.md
    // §10) - which is also why a phone with no Google Play services loses nothing but the
    // banner.
    expect(await notifications.list(userId, 'en', {}, 10, 0)).toHaveLength(1);
  });

  it('records it even when the sender fails outright', async () => {
    const userId = await newUser();
    await devices.register(userId, {
      token: randomUUID(),
      platform: 'android',
    });
    sender.outcome = 'failed';

    await notifications.notify({ userId, event: 'account_action' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    sender.outcome = 'sent';

    expect(await notifications.list(userId, 'en', {}, 10, 0)).toHaveLength(1);
  });
});
