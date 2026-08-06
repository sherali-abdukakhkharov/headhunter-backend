import type { InvitationStatus } from '@infra/db/database.types';

import {
  CANDIDATE_RESPONSES,
  canRespond,
  isTerminal,
  occupiesOpenSlot,
} from './invitation-status';

const ALL: InvitationStatus[] = [
  'sent',
  'details_requested',
  'accepted',
  'declined',
];

/**
 * The invitation machine (§8.2).
 *
 * Pinned exactly rather than sampled, the way M5 and M6 pin their transition tables: a
 * status machine is a table, and a test that checks three transitions leaves the rest to
 * whoever edits the code next.
 */
describe('canRespond', () => {
  const allowed = new Set([
    'sent>accepted',
    'sent>declined',
    'sent>details_requested',
    'details_requested>accepted',
    'details_requested>declined',
  ]);

  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canRespond(from, to)).toBe(allowed.has(`${from}>${to}`));
    },
  );

  it('refuses a second "request details", which would record that nothing happened', () => {
    expect(canRespond('details_requested', 'details_requested')).toBe(false);
  });

  it('lets a candidate who asked for details still accept or decline', () => {
    expect(canRespond('details_requested', 'accepted')).toBe(true);
    expect(canRespond('details_requested', 'declined')).toBe(true);
  });

  it('has no transition out of an answered invitation', () => {
    for (const from of ['accepted', 'declined'] as const) {
      for (const to of ALL) {
        expect(canRespond(from, to)).toBe(false);
      }
    }
  });
});

describe('isTerminal', () => {
  it.each(ALL)('%s', (status) => {
    expect(isTerminal(status)).toBe(
      status === 'accepted' || status === 'declined',
    );
  });
});

describe('occupiesOpenSlot', () => {
  it.each(ALL)('%s', (status) => {
    // The same rule as the partial unique index, written in the other language. Asserted
    // here so the two are held together rather than trusted to agree; the integration
    // spec then proves the index itself behaves this way.
    expect(occupiesOpenSlot(status)).toBe(
      status === 'sent' || status === 'details_requested',
    );
  });
});

describe('CANDIDATE_RESPONSES', () => {
  it('is exactly §8.2’s three actions', () => {
    expect(CANDIDATE_RESPONSES).toEqual([
      'accepted',
      'declined',
      'details_requested',
    ]);
  });

  it('never contains `sent`, which is what creating an invitation is', () => {
    expect(CANDIDATE_RESPONSES).not.toContain('sent');
  });
});
