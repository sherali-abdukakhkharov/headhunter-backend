import type { ApplicationStatus } from '@infra/db/database.types';

import {
  EMPLOYER_STAGES,
  actorFor,
  canTransition,
  isTerminal,
  occupiesActiveSlot,
} from './application-status';

/**
 * The application stage machine (§8.1, §5.6).
 *
 * §8.1's second column - who may set each stage - is a rule as much as the transitions
 * are, so both are pinned here. The forward-only property is the one worth guarding: a
 * candidate told they were shortlisted and then moved back to `viewed` has been told
 * something false, and the history would be the only evidence.
 */

const ALL: ApplicationStatus[] = [
  'submitted',
  'viewed',
  'shortlisted',
  'interview',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
];

describe('application stage machine', () => {
  it('treats hired, rejected and withdrawn as final (§5.6)', () => {
    expect(ALL.filter(isTerminal).sort()).toEqual(
      ['hired', 'rejected', 'withdrawn'].sort(),
    );
  });

  it('allows no transition out of a final stage', () => {
    for (const from of ['hired', 'rejected', 'withdrawn'] as const) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('never allows a transition to itself', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('allows forward moves, including skipping a stage', () => {
    // Real hiring skips: an employer who already knows the candidate goes straight from
    // submitted to offer, and §8.1 lists stages without requiring each to be visited.
    expect(canTransition('submitted', 'viewed')).toBe(true);
    expect(canTransition('submitted', 'offer')).toBe(true);
    expect(canTransition('viewed', 'hired')).toBe(true);
  });

  it('never allows a backwards move', () => {
    expect(canTransition('shortlisted', 'viewed')).toBe(false);
    expect(canTransition('offer', 'interview')).toBe(false);
    expect(canTransition('interview', 'submitted')).toBe(false);
  });

  it('allows rejection and withdrawal from every live stage', () => {
    for (const from of [
      'submitted',
      'viewed',
      'shortlisted',
      'interview',
      'offer',
    ] as const) {
      expect(canTransition(from, 'rejected')).toBe(true);
      // §5.6: "withdrawal before an accepted offer" - which `hired` being terminal
      // already expresses, so every live stage qualifies.
      expect(canTransition(from, 'withdrawn')).toBe(true);
    }
  });

  it('assigns each stage to the side §8.1 says owns it', () => {
    expect(actorFor('withdrawn')).toBe('candidate');
    expect(actorFor('submitted')).toBeNull();

    for (const stage of EMPLOYER_STAGES) {
      expect(actorFor(stage)).toBe('employer');
    }
  });

  it('offers the employer every stage except submitted and withdrawn', () => {
    expect([...EMPLOYER_STAGES].sort()).toEqual(
      [
        'hired',
        'interview',
        'offer',
        'rejected',
        'shortlisted',
        'viewed',
      ].sort(),
    );
  });

  it('matches BR-07’s partial index on which stages hold the slot', () => {
    // The same rule is written twice - here and in the index predicate - so they are
    // asserted against each other rather than trusted to agree.
    expect(ALL.filter((status) => !occupiesActiveSlot(status)).sort()).toEqual(
      ['rejected', 'withdrawn'].sort(),
    );
  });
});
