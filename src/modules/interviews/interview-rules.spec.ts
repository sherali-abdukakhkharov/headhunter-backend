import type { InterviewStatus } from '@infra/db/database.types';

import {
  CANDIDATE_RESPONSES,
  canRespond,
  detailViolation,
  isTerminal,
  statusAfterReschedule,
} from './interview-rules';

const ALL: InterviewStatus[] = [
  'scheduled',
  'confirmed',
  'reschedule_requested',
  'cancelled',
];

/**
 * §8.3's "location / link required according to interview type".
 *
 * The CHECK constraint enforces the same three shapes; these tests are its readable twin,
 * and they cover the half a constraint is easy to get wrong - the *absence* checks. A
 * phone interview carrying a meeting link is not a phone interview, and storing one would
 * show the candidate a link nobody meant them to use.
 */
describe('detailViolation', () => {
  it('accepts a phone interview with neither detail', () => {
    expect(detailViolation({ type: 'phone' })).toBeNull();
  });

  it('accepts an in-person interview with an address', () => {
    expect(
      detailViolation({ type: 'in_person', location: 'Amir Temur 1' }),
    ).toBeNull();
  });

  it('accepts an external-link interview with a link', () => {
    expect(
      detailViolation({
        type: 'external_link',
        meetingLink: 'https://meet.example/abc',
      }),
    ).toBeNull();
  });

  it.each([
    ['in_person with no address', { type: 'in_person' as const }, 'location'],
    [
      'external_link with no link',
      { type: 'external_link' as const },
      'meetingLink',
    ],
    [
      'phone carrying an address',
      { type: 'phone' as const, location: 'Amir Temur 1' },
      'location',
    ],
    [
      'phone carrying a link',
      { type: 'phone' as const, meetingLink: 'https://meet.example/abc' },
      'meetingLink',
    ],
    [
      'in_person carrying a link as well',
      {
        type: 'in_person' as const,
        location: 'Amir Temur 1',
        meetingLink: 'https://meet.example/abc',
      },
      'meetingLink',
    ],
    [
      'external_link carrying an address as well',
      {
        type: 'external_link' as const,
        meetingLink: 'https://meet.example/abc',
        location: 'Amir Temur 1',
      },
      'location',
    ],
  ])('refuses %s', (_name, details, expected) => {
    expect(detailViolation(details)).toBe(expected);
  });

  it('treats whitespace as absent, so a spacebar is not an address', () => {
    expect(detailViolation({ type: 'in_person', location: '   ' })).toBe(
      'location',
    );
  });
});

describe('canRespond', () => {
  const allowed = new Set([
    'scheduled>confirmed',
    'scheduled>reschedule_requested',
    'confirmed>reschedule_requested',
    'reschedule_requested>confirmed',
  ]);

  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canRespond(from, to)).toBe(allowed.has(`${from}>${to}`));
    },
  );

  it('lets a candidate who confirmed ask for another time after all', () => {
    // Plans change, which is the whole reason `confirmed` is not terminal.
    expect(canRespond('confirmed', 'reschedule_requested')).toBe(true);
  });

  it('refuses saying the same thing twice', () => {
    expect(canRespond('confirmed', 'confirmed')).toBe(false);
    expect(canRespond('reschedule_requested', 'reschedule_requested')).toBe(
      false,
    );
  });

  it('has no transition out of a cancelled interview', () => {
    for (const to of ALL) {
      expect(canRespond('cancelled', to)).toBe(false);
    }
  });

  it('never lets the candidate cancel: that is the employer’s action', () => {
    expect(CANDIDATE_RESPONSES).not.toContain('cancelled');
    expect(canRespond('scheduled', 'cancelled')).toBe(false);
  });
});

describe('isTerminal', () => {
  it.each(ALL)('%s', (status) => {
    expect(isTerminal(status)).toBe(status === 'cancelled');
  });
});

describe('statusAfterReschedule', () => {
  it('always returns the interview to unanswered', () => {
    // An interview moved to another time has not been confirmed, whatever was said about
    // the old one.
    expect(statusAfterReschedule()).toBe('scheduled');
  });
});
