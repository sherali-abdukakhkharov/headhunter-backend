import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { LocaleCode, NotificationEvent } from '@infra/db/database.types';
import type { MessageParams } from '@infra/i18n/messages';
import { translate } from '@infra/i18n/translate';

import { NOTIFICATION_EVENTS } from '../notification-events';
import { type PushMessage, PushSender } from './push-sender';

export interface DispatchInput {
  userId: string;
  notificationId: string;
  event: NotificationEvent;
  params: MessageParams;
  target: { type: string; id: string } | null;
}

/**
 * Turns a stored notification into pushes to that user's devices (§9.2).
 *
 * Everything that is *about the product* lives here, and everything that is about a
 * provider lives behind `PushSender`: the recipient's devices, their language, the deep
 * link, and what to do with a token FCM says is dead.
 *
 * **Never throws.** ARCHITECTURE.md §10: the in-app row is the record and push is best
 * effort, so a provider outage produces log lines and nothing else. `NotificationsService`
 * does not await the result for the same reason.
 */
@Injectable()
export class PushDispatcher {
  private readonly logger = new Logger(PushDispatcher.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly sender: PushSender,
  ) {}

  async dispatch(input: DispatchInput): Promise<void> {
    try {
      await this.deliver(input);
    } catch (error) {
      this.logger.error(
        `Push dispatch failed for ${input.event} to ${input.userId}: ${String(error)}`,
      );
    }
  }

  private async deliver(input: DispatchInput): Promise<void> {
    const recipient = await this.db
      .selectFrom('users')
      .select('locale')
      .where('id', '=', input.userId)
      .executeTakeFirst();

    if (!recipient) {
      return;
    }

    const tokens = await this.db
      .selectFrom('device_tokens')
      .select('token')
      .where('user_id', '=', input.userId)
      .where('disabled_at', 'is', null)
      .execute();

    if (tokens.length === 0) {
      // Ordinary: a user who has never opened the app on a device with push permission,
      // or one whose phone has no Google Play services at all. The in-app row is already
      // written, so they see it when they next open the app.
      return;
    }

    const results = await this.sender.send(
      tokens.map((row) => this.messageFor(input, row.token, recipient.locale)),
    );
    const dead = results
      .filter((result) => result.status === 'invalid')
      .map((result) => result.token);

    if (dead.length > 0) {
      // Disabled rather than deleted, so a device that reappears is recognised and
      // "this user has no working device" stays answerable.
      await this.db
        .updateTable('device_tokens')
        .set({ disabled_at: sql`now()` })
        .where('token', 'in', dead)
        .execute();

      this.logger.log(`Disabled ${dead.length} unregistered device token(s)`);
    }

    const failed = results.filter((result) => result.status === 'failed');

    for (const failure of failed) {
      this.logger.warn(`Push failed: ${failure.error ?? 'unknown error'}`);
    }
  }

  /**
   * The push copy, rendered in the recipient's language at send time.
   *
   * The title is the product's name rather than the event's, because a phone's
   * notification shade already groups by app and repeating "HeadHunter" in the body would
   * waste the one line that matters. The body is the same sentence the in-app list shows.
   */
  private messageFor(
    input: DispatchInput,
    token: string,
    locale: LocaleCode,
  ): PushMessage {
    const spec = NOTIFICATION_EVENTS[input.event];

    return {
      token,
      title: translate(spec.messageKey, locale, input.params).slice(0, 120),
      body: translate(spec.messageKey, locale, input.params),
      // String-to-string, as FCM requires. The client routes on these rather than parsing
      // the text - which is also why the deep link is not baked into the sentence.
      data: {
        notificationId: input.notificationId,
        event: input.event,
        ...(input.target
          ? { targetType: input.target.type, targetId: input.target.id }
          : {}),
      },
      locale,
    };
  }
}
