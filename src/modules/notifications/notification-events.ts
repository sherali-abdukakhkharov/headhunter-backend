import type {
  NotificationCategory,
  NotificationEvent,
} from '@infra/db/database.types';
import type { MessageKey } from '@infra/i18n/messages';

/**
 * §9.2's table, as one declaration.
 *
 * The specification gives nine rows of "event → recipient". Three things have to be true
 * of each, and keeping them in one object is what makes them true together rather than in
 * three files that drift:
 *
 * - **Which category it belongs to**, because §9.2's preferences switch categories off.
 * - **Whether that category may be switched off at all.** "Security and account notices
 *   remain enabled" - so `account` is not a user's choice, and the CHECK constraint on
 *   `notification_preferences` says so as well.
 * - **Which message key renders it**, in all four variants. A notification never stores
 *   text (see the migration), so this key is what the read path resolves against the
 *   caller's `x-lang`.
 *
 * The recipient is *not* here. It is a property of the event's data - the employer who
 * owns the vacancy, the other participant in a conversation - so it belongs at the call
 * site, which is the only place that knows it.
 */

export interface NotificationEventSpec {
  category: NotificationCategory;
  messageKey: MessageKey;
  /**
   * The `{placeholders}` this event's message expects.
   *
   * Declared so a test can assert that every key's four translations use exactly these
   * and no others - a placeholder present in one language and missing in another renders
   * as literal braces to that user, which is the failure §3.2 is about.
   */
  params: string[];
}

export const NOTIFICATION_EVENTS: Record<
  NotificationEvent,
  NotificationEventSpec
> = {
  // §9.2 row 1: "New application → Employer".
  application_created: {
    category: 'applications',
    messageKey: 'notification.application_created',
    params: ['vacancy'],
  },
  // Row 2: "Application status changed → Candidate". §8.1's `offer` stage arrives through
  // here rather than through the invitation event, which is why row 3's "or offer" does
  // not need a code of its own.
  application_status_changed: {
    category: 'applications',
    messageKey: 'notification.application_status_changed',
    // No status in the sentence: a stage code interpolated into it would reach the reader
    // untranslated (§3.2). The client renders the stage from the target it links to.
    params: ['vacancy'],
  },
  // Row 3: "New invitation or offer → Candidate".
  invitation_received: {
    category: 'invitations',
    messageKey: 'notification.invitation_received',
    params: ['employer'],
  },
  // Row 4: "Invitation response → Employer".
  invitation_responded: {
    category: 'invitations',
    messageKey: 'notification.invitation_responded',
    params: ['candidate'],
  },
  // Row 5: "New chat message → Recipient".
  message_received: {
    category: 'messages',
    messageKey: 'notification.message_received',
    params: ['sender'],
  },
  // Row 6: "Interview created or changed → Both parties", as two sentences and one
  // setting - see the migration.
  interview_scheduled: {
    category: 'interviews',
    messageKey: 'notification.interview_scheduled',
    params: ['when'],
  },
  interview_changed: {
    category: 'interviews',
    messageKey: 'notification.interview_changed',
    params: ['when'],
  },
  // Row 7: "Vacancy moderation result → Employer". An `account` notice rather than an
  // `applications` one, and deliberately not disableable: an employer who has muted this
  // cannot know why their vacancy is invisible.
  vacancy_moderated: {
    category: 'account',
    messageKey: 'notification.vacancy_moderated',
    params: ['vacancy'],
  },
  // Row 8: "Employer verification result → Employer". Same reasoning: BR-03 blocks
  // everything on this outcome, so it is not a preference.
  verification_decided: {
    category: 'account',
    messageKey: 'notification.verification_decided',
    params: [],
  },
  // Row 9: "Administrative restriction or complaint decision → Affected user". §9.2's
  // "security and account notices" in the narrowest sense.
  account_action: {
    category: 'account',
    messageKey: 'notification.account_action',
    params: [],
  },
};

/**
 * The one category §9.2 keeps out of the user's hands.
 *
 * Exported so the service, the DTO and the test all read the same fact, and asserted
 * against the CHECK constraint by the integration suite: the same rule written twice, in
 * two languages.
 */
export const ALWAYS_ON_CATEGORY: NotificationCategory = 'account';

export function isDisableable(category: NotificationCategory): boolean {
  return category !== ALWAYS_ON_CATEGORY;
}

/** Every category a user may switch off, for the preferences screen. */
export function disableableCategories(): NotificationCategory[] {
  return [
    ...new Set(Object.values(NOTIFICATION_EVENTS).map((spec) => spec.category)),
  ]
    .filter(isDisableable)
    .sort();
}
