import type {
  RequirementRow,
  VacancyAggregate,
  VacancyRow,
} from '@modules/vacancies/vacancy-state';

import { prefillFilters } from './search-prefill';

/**
 * UAT-06's prefill: a vacancy's requirements as candidate-search filters.
 *
 * Unit tests rather than integration ones because the mapping is the whole content -
 * `loadVacancy` is already covered by M5's suite, and what can go wrong here is a code
 * mapped to the wrong filter, a preferred requirement leaking in as a hard filter, or a
 * BR-12 restriction arriving without the justification that permits it.
 */

const ROW: VacancyRow = {
  id: 'v1',
  employer_user_id: 'e1',
  category: 'service_operations',
  occupation_id: 'occ-call-centre',
  title: 'Call-centre operator',
  description: null,
  worker_count: 20,
  hired_count: 0,
  region_id: 'reg-tashkent',
  district_id: 'dist-yunusabad',
  address: null,
  salary_from: '4000000',
  salary_to: '6000000',
  salary_period_id: 'monthly',
  salary_is_negotiable: false,
  starts_on: '2026-09-01',
  ends_on: null,
  deadline_on: '2026-08-20',
  age_min: null,
  age_max: null,
  gender_id: null,
  restriction_justification_id: null,
  restriction_justification_note: null,
  status: 'active',
  moderation_reason: null,
  published_at: null,
  closed_at: null,
  closure_reason: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function requirement(overrides: Partial<RequirementRow>): RequirementRow {
  return {
    fieldCode: 'skills',
    itemId: null,
    levelId: null,
    levelRank: null,
    isMandatory: true,
    valueBool: null,
    valueInt: null,
    valueDecimal: null,
    valueText: null,
    valueDate: null,
    ...overrides,
  };
}

function aggregate(
  requirements: RequirementRow[],
  row: Partial<VacancyRow> = {},
): VacancyAggregate {
  return { row: { ...ROW, ...row }, requirements };
}

describe('prefillFilters', () => {
  it('carries the vacancy’s own facts across', () => {
    const filters = prefillFilters(aggregate([]));

    expect(filters).toMatchObject({
      occupationIds: ['occ-call-centre'],
      category: 'service_operations',
      regionId: 'reg-tashkent',
      districtIds: ['dist-yunusabad'],
      // The employer's ceiling, from the top of their range.
      salaryMax: 6_000_000,
      // §7.1's availability, from the date the work starts.
      availableBy: '2026-09-01',
    });
  });

  it('turns a mandatory language requirement into a level floor (UAT-06)', () => {
    const filters = prefillFilters(
      aggregate([
        requirement({
          fieldCode: 'languages',
          itemId: 'lang-ru',
          levelId: 'level-c1',
          levelRank: 5,
        }),
      ]),
    );

    expect(filters.languages).toEqual([{ itemId: 'lang-ru', minLevelRank: 5 }]);
  });

  it('drops a preferred requirement rather than filtering on it', () => {
    const filters = prefillFilters(
      aggregate([
        requirement({ itemId: 'skill-crm', isMandatory: true }),
        requirement({ itemId: 'skill-excel', isMandatory: false }),
        requirement({
          fieldCode: 'languages',
          itemId: 'lang-en',
          levelRank: 3,
          isMandatory: false,
        }),
      ]),
    );

    // A preference that excluded candidates would not be a preference. The score is what
    // rewards it instead.
    expect(filters.skillIds).toEqual(['skill-crm']);
    expect(filters.languages).toBeUndefined();
  });

  it('prefills mandatory skills as match-all, at the lowest level asked for', () => {
    const filters = prefillFilters(
      aggregate([
        requirement({ itemId: 'skill-crm', levelRank: 4 }),
        requirement({ itemId: 'skill-phone', levelRank: 2 }),
      ]),
    );

    expect(filters.skillsMatchMode).toBe('all');
    // Not 4: one floor stands for two per-skill levels, and the stricter of them would
    // exclude candidates the vacancy would accept.
    expect(filters.skillMinLevelRank).toBe(2);
  });

  it('collects every work-attribute group into one match-all filter', () => {
    const filters = prefillFilters(
      aggregate([
        requirement({ fieldCode: 'licence_ids', itemId: 'lic-b' }),
        requirement({ fieldCode: 'transport_ids', itemId: 'own-car' }),
        requirement({ fieldCode: 'tool_ids', itemId: 'hoe' }),
        requirement({ fieldCode: 'readiness_ids', itemId: 'field-travel' }),
      ]),
    );

    expect(filters.attributeIds).toEqual([
      'lic-b',
      'own-car',
      'hoe',
      'field-travel',
    ]);
    expect(filters.attributesMatchMode).toBe('all');
  });

  it('maps the scalar requirements to their filters (UAT-10’s shape)', () => {
    const filters = prefillFilters(
      aggregate([
        requirement({ fieldCode: 'experience_years_min', valueInt: 3 }),
        requirement({ fieldCode: 'education_level_id', itemId: 'edu-higher' }),
        requirement({ fieldCode: 'crew_required', valueBool: true }),
        requirement({ fieldCode: 'employment_type_ids', itemId: 'seasonal' }),
        requirement({ fieldCode: 'shift_ids', itemId: 'day' }),
      ]),
    );

    expect(filters).toMatchObject({
      experienceYearsMin: 3,
      educationLevelIds: ['edu-higher'],
      employmentTypeIds: ['seasonal'],
      shiftIds: ['day'],
      // A crew is more than one person; the employer can raise the floor.
      crewSizeMin: 2,
    });
  });

  it('states no budget for a negotiable vacancy', () => {
    const filters = prefillFilters(
      aggregate([], { salary_is_negotiable: true }),
    );

    expect(filters.salaryMax).toBeUndefined();
  });

  it('falls back to the bottom of the range when no ceiling is stated', () => {
    const filters = prefillFilters(aggregate([], { salary_to: null }));

    expect(filters.salaryMax).toBe(4_000_000);
  });

  it('carries a BR-12 restriction only with the justification that permits it', () => {
    const filters = prefillFilters(
      aggregate([], {
        age_min: 18,
        age_max: 60,
        gender_id: 'gender-female',
        restriction_justification_id: 'just-heavy-lifting',
      }),
    );

    // Without the id, UAT-06 would ask the employer to re-justify a restriction the
    // platform has already reviewed - and the search would refuse the filters outright.
    expect(filters).toMatchObject({
      ageMin: 18,
      ageMax: 60,
      genderId: 'gender-female',
      restrictionJustificationId: 'just-heavy-lifting',
    });
  });

  it('leaves out every filter the vacancy says nothing about', () => {
    const filters = prefillFilters(
      aggregate([], {
        occupation_id: null,
        category: null,
        region_id: null,
        district_id: null,
        starts_on: null,
        salary_from: null,
        salary_to: null,
      }),
    );

    // An absent filter must be absent, not present and empty: `scoreGroups` reads the
    // same object, and an empty group would be scored out of zero.
    expect(Object.keys(filters)).toEqual([]);
  });
});
