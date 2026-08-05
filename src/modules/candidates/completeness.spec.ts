import type { CompletenessEntry } from '@modules/schemas/schema-resolver';

import { computeCompleteness } from './completeness';

/**
 * §5.3's percentage and BR-02's gate.
 *
 * The distinction these tests exist to hold: the percentage is measured over
 * everything, `isComplete` only over the required entries. Collapsing the second
 * into a threshold on the first is the mistake that would let a profile with no
 * occupation become searchable at 80%.
 */
describe('computeCompleteness', () => {
  const entries: CompletenessEntry[] = [
    { code: 'full_name', section: 'personal', required: true },
    { code: 'region_id', section: 'location', required: true },
    { code: 'settlement', section: 'location', required: false },
    { code: 'skills', section: 'skills', required: false },
    { code: 'experience', section: 'experience', required: false },
  ];

  it('reports the share of all entries that are filled', () => {
    const result = computeCompleteness(
      entries,
      new Set(['full_name', 'region_id']),
    );

    expect(result.percent).toBe(40);
  });

  it('is complete once every required entry is filled, not at 100%', () => {
    const result = computeCompleteness(
      entries,
      new Set(['full_name', 'region_id']),
    );

    expect(result.isComplete).toBe(true);
    expect(result.percent).toBeLessThan(100);
  });

  it('is incomplete while a required entry is missing, however full the rest is', () => {
    const result = computeCompleteness(
      entries,
      new Set(['full_name', 'settlement', 'skills', 'experience']),
    );

    expect(result.isComplete).toBe(false);
    expect(result.percent).toBe(80);
  });

  it('lists what is missing with its section and whether it blocks searchability', () => {
    const result = computeCompleteness(entries, new Set(['full_name']));

    expect(result.missing).toEqual([
      { code: 'region_id', section: 'location', required: true },
      { code: 'settlement', section: 'location', required: false },
      { code: 'skills', section: 'skills', required: false },
      { code: 'experience', section: 'experience', required: false },
    ]);
  });

  it('reports 100 and complete when nothing is missing', () => {
    const result = computeCompleteness(
      entries,
      new Set(entries.map((entry) => entry.code)),
    );

    expect(result).toEqual({ percent: 100, isComplete: true, missing: [] });
  });

  it('rounds rather than truncating', () => {
    // 1 of 3 is 33.33; a truncating implementation would report 33 for 2 of 3 too.
    const three = entries.slice(0, 3);

    expect(computeCompleteness(three, new Set(['full_name'])).percent).toBe(33);
    expect(
      computeCompleteness(three, new Set(['full_name', 'region_id'])).percent,
    ).toBe(67);
  });
});
