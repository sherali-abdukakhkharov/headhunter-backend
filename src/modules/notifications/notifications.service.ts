import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  LocaleCode,
  NotificationCategory,
  NotificationEvent,
} from '@infra/db/database.types';
import type { MessageParams } from '@infra/i18n/messages';
import { translate } from '@infra/i18n/translate';

import {
  ALWAYS_ON_CATEGORY,
  NOTIFICATION_EVENTS,
  disableableCategories,
  isDisableable,
} from './notification-events';
import { PushDispatcher } from './push/push-dispatcher.service';

export interface NotificationInput {
  userId: string;
  event: NotificationEvent;
  /** What the sentence interpolates. Never the sentence. */
  params?: MessageParams;
  /** The deep link: what tapping it should open. */
  target?: { type: string; id: string };
}

export interface NotificationView {
  id: string;
  event: NotificationEvent;
  category: NotificationCategory;
  /** Rendered **now**, in the reader's current language - see the class comment. */
  text: string;
  targetType: string | null;
  targetId: string | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * §9.2's notifications.
 *
 * Three decisions shape this service.
 *
 * - **The row stores a key and its parameters, never text.** `users.locale` can change
 *   after a notification is written, so rendering at write time would freeze somebody's
 *   history in the language they used last month. The list is resolved through the same
 *   catalog and the same `x-lang` chain every error message uses.
 * - **The in-app row is the record; push is best effort** (ARCHITECTURE.md §10). The row
 *   is written first and the dispatch is fired afterwards without being awaited for its
 *   result, so a dead FCM never costs a notification.
 * - **Writing one is never allowed to break the thing that caused it.** `notify` catches
 *   its own failures and logs them: an employer's vacancy must not fail to publish because
 *   a notification insert deadlocked. That is the opposite of the audit log's rule, and
 *   deliberately so - one is a record of what happened, the other is a message about it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly push: PushDispatcher,
  ) {}

  /**
   * Records a notification and pushes it, honouring §9.2's preferences.
   *
   * Never throws. Callers invoke it after their own transaction has committed, and a
   * caller that had to handle its failure would end up choosing between rolling back a
   * hire and ignoring the error anyway.
   */
  async notify(input: NotificationInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.error(
        `Failed to notify ${input.userId} of ${input.event}: ${String(error)}`,
      );
    }
  }

  /** Several recipients of the same event - §9.2's "both parties" for an interview. */
  async notifyAll(inputs: NotificationInput[]): Promise<void> {
    await Promise.all(inputs.map((input) => this.notify(input)));
  }

  private async record(input: NotificationInput): Promise<void> {
    const spec = NOTIFICATION_EVENTS[input.event];

    if (!(await this.isEnabled(input.userId, spec.category))) {
      // A disabled category stores nothing at all, rather than storing a row the list
      // then has to filter: §9.2 lets a user switch a category off, and a badge counting
      // notifications they asked not to receive would be the same thing as not switching
      // it off.
      return;
    }

    const row = await this.db
      .insertInto('notifications')
      .values({
        user_id: input.userId,
        event: input.event,
        category: spec.category,
        target_type: input.target?.type ?? null,
        target_id: input.target?.id ?? null,
        params: input.params ? JSON.stringify(input.params) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Not awaited for its outcome: the record exists, and the push is an attempt on top of
    // it. A failure is logged by the dispatcher rather than raised here.
    void this.push.dispatch({
      userId: input.userId,
      notificationId: row.id,
      event: input.event,
      params: input.params ?? {},
      target: input.target ?? null,
    });
  }

  /** §9.2's in-app list, rendered in the caller's language. */
  async list(
    userId: string,
    locale: LocaleCode,
    filters: { unreadOnly?: boolean },
    limit: number,
    offset: number,
  ): Promise<NotificationView[]> {
    let query = this.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId);

    if (filters.unreadOnly) {
      query = query.where('read_at', 'is', null);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      category: row.category,
      text: translate(
        NOTIFICATION_EVENTS[row.event].messageKey,
        locale,
        (row.params as MessageParams | null) ?? undefined,
      ),
      targetType: row.target_type,
      targetId: row.target_id,
      isRead: row.read_at !== null,
      createdAt: row.created_at,
    }));
  }

  /** The badge. One indexed count, because it is polled far more often than the list. */
  async unreadCount(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const result = await this.db
      .updateTable('notifications')
      .set({ read_at: sql`now()` })
      .where('id', '=', notificationId)
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) {
      // Either it is not theirs, or it was already read. Already-read is not an error, so
      // this only throws when the row is not the caller's to begin with.
      const exists = await this.db
        .selectFrom('notifications')
        .select('id')
        .where('id', '=', notificationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (!exists) {
        throw new NotFoundError('notification.not_found');
      }
    }
  }

  /** "Mark all as read", which is the button every list of this shape has. */
  async markAllRead(userId: string): Promise<number> {
    const result = await this.db
      .updateTable('notifications')
      .set({ read_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /**
   * §9.2's preferences: every category the user may switch off, and its current state.
   *
   * The always-on category is reported too, flagged, so the settings screen can show it
   * greyed out rather than pretending it does not exist - a user who cannot find "account
   * notices" in the list will assume they are off.
   */
  async preferences(
    userId: string,
  ): Promise<
    { category: NotificationCategory; enabled: boolean; canDisable: boolean }[]
  > {
    const rows = await this.db
      .selectFrom('notification_preferences')
      .select(['category', 'enabled'])
      .where('user_id', '=', userId)
      .execute();

    const stored = new Map(rows.map((row) => [row.category, row.enabled]));
    const categories: NotificationCategory[] = [
      ...disableableCategories(),
      ALWAYS_ON_CATEGORY,
    ];

    return categories.map((category) => ({
      category,
      // Absence means enabled: a user who has never opened the settings screen gets
      // everything, which is the only default that does not lose their first notification.
      enabled: stored.get(category) ?? true,
      canDisable: isDisableable(category),
    }));
  }

  async setPreference(
    userId: string,
    category: NotificationCategory,
    enabled: boolean,
  ): Promise<void> {
    if (!enabled && !isDisableable(category)) {
      // §9.2: "security and account notices remain enabled". The CHECK constraint refuses
      // the row as well; this exists so the answer is a message rather than a constraint
      // error.
      throw new ForbiddenError('notification.category_not_disableable');
    }

    await this.db
      .insertInto('notification_preferences')
      .values({ user_id: userId, category, enabled })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'category'])
          .doUpdateSet({ enabled, updated_at: sql`now()` }),
      )
      .execute();
  }

  private async isEnabled(
    userId: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    if (!isDisableable(category)) {
      return true;
    }

    const row = await this.db
      .selectFrom('notification_preferences')
      .select('enabled')
      .where('user_id', '=', userId)
      .where('category', '=', category)
      .executeTakeFirst();

    return row?.enabled ?? true;
  }
}
