import type { VacancyStatus } from '@infra/db/database.types';

import {
  RESTRICTION_JUSTIFICATIONS,
  isJustificationValid,
} from './age-gender-justifications';
import {
  canSubmitFrom,
  canTransition,
  isEditable,
  isOpenForApplications,
  restrictionKinds,
} from './vacancy-status';

/**
 * The vacancy machine's rules, as pure functions.
 *
 * §6.4 defines the transitions and BR-11 makes `closed` terminal; both are properties
 * worth pinning, because a service that gained one extra legal transition would be
 * hard to notice and easy to regret.
 */

const ALL: VacancyStatus[] = [
  'draft',
  'under_moderation',
  'active',
  'paused',
  'closed',
  'rejected',
];

describe('vacancy status machine', () => {
  it('allows exactly the transitions of §6.4', () => {
    const legal = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );

    expect(legal.sort()).toEqual(
      [
        'draft->under_moderation',
        'draft->active',
        'under_moderation->active',
        'under_moderation->rejected',
        'rejected->draft',
        'active->paused',
        'active->closed',
        'active->under_moderation',
        'paused->active',
        'paused->closed',
        'paused->under_moderation',
      ].sort(),
    );
  });

  it('makes closed terminal (BR-11)', () => {
    // Closed leaves discovery and stays in history. Reopening one would make "closed"
    // mean nothing to the candidates who already saw it.
    for (const to of ALL) {
      expect(canTransition('closed', to)).toBe(false);
    }
  });

  it('never allows a transition to itself', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('lets an employer edit everything except a vacancy under review or closed', () => {
    expect(ALL.filter(isEditable).sort()).toEqual(
      ['active', 'draft', 'paused', 'rejected'].sort(),
    );
    // Under review: a moderator is reading it, and an edit mid-review would have them
    // approve something other than what they saw.
    expect(isEditable('under_moderation')).toBe(false);
    expect(isEditable('closed')).toBe(false);
  });

  it('submits only from draft or rejected', () => {
    expect(ALL.filter(canSubmitFrom).sort()).toEqual(['draft', 'rejected']);
  });
});

describe('isOpenForApplications (BR-06)', () => {
  const today = '2026-08-05';

  it('is open while active with no deadline', () => {
    expect(isOpenForApplications('active', null, today)).toBe(true);
  });

  it('is open on the deadline day itself', () => {
    // The deadline is the last day applications are accepted, not the first day they
    // are refused.
    expect(isOpenForApplications('active', today, today)).toBe(true);
  });

  it('is closed the day after the deadline', () => {
    expect(isOpenForApplications('active', '2026-08-04', today)).toBe(false);
  });

  it.each([
    'draft',
    'under_moderation',
    'paused',
    'closed',
    'rejected',
  ] as const)('is closed while %s, whatever the deadline', (status) => {
    expect(isOpenForApplications(status, null, today)).toBe(false);
  });
});

describe('restrictionKinds (BR-12)', () => {
  const none = { age_min: null, age_max: null, gender_id: null };

  it('reports nothing for an unrestricted vacancy', () => {
    expect(restrictionKinds(none)).toEqual([]);
  });

  it('reports age for either bound alone', () => {
    expect(restrictionKinds({ ...none, age_min: 18 })).toEqual(['age']);
    expect(restrictionKinds({ ...none, age_max: 40 })).toEqual(['age']);
  });

  it('reports both when both are present', () => {
    expect(
      restrictionKinds({ age_min: 18, age_max: 40, gender_id: 'x' }),
    ).toEqual(['age', 'gender']);
  });
});

describe('isJustificationValid (BR-12)', () => {
  it('refuses an unknown code', () => {
    // Free prose cannot be validated, which is why the reason is enumerated at all.
    expect(isJustificationValid('young_dynamic_team', ['age'])).toBe(false);
    expect(isJustificationValid('', ['age'])).toBe(false);
  });

  it('refuses a reason that does not support the restriction actually stated', () => {
    // A gender restriction justified by a minimum-age rule is not justified.
    expect(isJustificationValid('statutory_minimum_age', ['gender'])).toBe(
      false,
    );
    expect(isJustificationValid('single_sex_facility', ['age'])).toBe(false);
  });

  it('requires the reason to cover every restriction present', () => {
    expect(isJustificationValid('single_sex_facility', ['age', 'gender'])).toBe(
      false,
    );
    expect(
      isJustificationValid('heavy_lifting_limits', ['age', 'gender']),
    ).toBe(true);
  });

  it('accepts a reason for the kind it declares', () => {
    expect(isJustificationValid('statutory_minimum_age', ['age'])).toBe(true);
    expect(isJustificationValid('night_work_restriction', ['age'])).toBe(true);
  });

  it('states provenance and an argument for every permitted reason', () => {
    for (const justification of RESTRICTION_JUSTIFICATIONS) {
      // The provenance decides who may change the value; the note is what a reviewer
      // needs in order to disagree with it. The set is written out rather than derived
      // from the type, so widening it stays a deliberate act - `client` was added here
      // when the client approved the list on 2026-08-20.
      expect(['spec', 'client', 'default']).toContain(justification.provenance);
      expect(justification.note.length).toBeGreaterThan(40);
      expect(justification.applies.length).toBeGreaterThan(0);
    }
  });

  it('permits no reason that is a preference rather than a condition of the work', () => {
    // A guard against the failure mode BR-12 exists to prevent: a commercial or
    // customer preference on this list would make the platform the instrument of the
    // discrimination it is meant to catch.
    const codes = RESTRICTION_JUSTIFICATIONS.map((item) => item.code);

    for (const forbidden of [
      'client_preference',
      'customer_request',
      'team_culture',
      'employer_preference',
    ]) {
      expect(codes).not.toContain(forbidden);
    }
  });
});
