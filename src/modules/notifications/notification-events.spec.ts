import { MESSAGES } from '@infra/i18n/messages';
import { translate } from '@infra/i18n/translate';

import {
  ALWAYS_ON_CATEGORY,
  NOTIFICATION_EVENTS,
  disableableCategories,
  isDisableable,
} from './notification-events';

const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;
const EVENTS = Object.keys(
  NOTIFICATION_EVENTS,
) as (keyof typeof NOTIFICATION_EVENTS)[];

/** Every `{placeholder}` a template interpolates. */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

/**
 * §9.2's event table, and the §3.2 trap underneath it.
 *
 * A notification stores a message key and its parameters rather than text, so the four
 * translations of one key have to agree about which parameters exist. A placeholder
 * present in Russian and missing in Uzbek renders as literal braces to one of the two
 * users - the exact failure §3.2 exists to prevent, and one that no request would ever
 * surface in review.
 */
describe('the notification catalogue', () => {
  it('covers all ten §9.2 event codes', () => {
    expect(EVENTS).toHaveLength(10);
  });

  it.each(EVENTS)('%s resolves to a key with all four locales', (event) => {
    const entry = MESSAGES[NOTIFICATION_EVENTS[event].messageKey] as Record<
      string,
      string
    >;

    expect(entry).toBeDefined();

    for (const locale of LOCALES) {
      expect(typeof entry[locale]).toBe('string');
      expect(entry[locale].length).toBeGreaterThan(0);
    }
  });

  it.each(EVENTS)('%s uses the same placeholders in every variant', (event) => {
    const spec = NOTIFICATION_EVENTS[event];
    const entry = MESSAGES[spec.messageKey] as Record<string, string>;
    const declared = [...spec.params].sort();

    for (const locale of LOCALES) {
      // Against the declaration *and* against each other: a template that interpolates
      // something the call site never passes renders as braces just as badly as one that
      // omits a value the others show.
      expect(placeholdersOf(entry[locale])).toEqual(declared);
    }
  });

  it.each(EVENTS)(
    '%s leaves no unsubstituted braces when rendered',
    (event) => {
      const spec = NOTIFICATION_EVENTS[event];
      const params = Object.fromEntries(
        spec.params.map((name) => [name, 'value']),
      );

      for (const locale of LOCALES) {
        expect(translate(spec.messageKey, locale, params)).not.toContain('{');
      }
    },
  );
});

describe('§9.2’s categories', () => {
  it('keeps account notices out of the user’s hands', () => {
    expect(ALWAYS_ON_CATEGORY).toBe('account');
    expect(isDisableable('account')).toBe(false);
    expect(disableableCategories()).not.toContain('account');
  });

  it('lets every other category be switched off', () => {
    expect(disableableCategories()).toEqual([
      'applications',
      'interviews',
      'invitations',
      'messages',
    ]);
  });

  it('files the three account-standing events as non-disableable', () => {
    // A user who muted these could not learn why their vacancy is invisible, why their
    // verification failed, or that they have been restricted - each of which they have to
    // act on and none of which they can act on unseen.
    for (const event of [
      'vacancy_moderated',
      'verification_decided',
      'account_action',
    ] as const) {
      expect(NOTIFICATION_EVENTS[event].category).toBe('account');
    }
  });

  it('files the rest where a user would look for them', () => {
    expect(NOTIFICATION_EVENTS.application_created.category).toBe(
      'applications',
    );
    expect(NOTIFICATION_EVENTS.invitation_received.category).toBe(
      'invitations',
    );
    expect(NOTIFICATION_EVENTS.message_received.category).toBe('messages');
    expect(NOTIFICATION_EVENTS.interview_scheduled.category).toBe('interviews');
    // "Interview created or changed" is one row in §9.2 and therefore one setting, even
    // though it is two sentences.
    expect(NOTIFICATION_EVENTS.interview_changed.category).toBe('interviews');
  });
});
