import type { VacancyAggregate } from '@modules/vacancies/vacancy-state';

import type { CandidateSearchFilters } from './search-filters';

/**
 * UAT-06: candidate search opened from a vacancy arrives with the vacancy's
 * requirements as an editable filter set (§7).
 *
 * Pure, and deliberately so: this is the contract between the two field schemas, and it
 * is testable without a database or a request. What makes it possible at all is that
 * `candidate-profile.schema.ts` and `vacancy.schema.ts` share field codes and the schema
 * contract test pins that a shared code means the same thing on both sides - so the
 * mapping is by code rather than by a translation table that could drift from either.
 *
 * Two decisions decide almost every line below:
 *
 * - **Mandatory requirements become filters; preferred ones do not.** §6.3 lets an
 *   employer mark a skill or language preferred, and a preference that silently excluded
 *   candidates would be neither. They are dropped from the filter set rather than
 *   softened into it - and the match score then rewards the candidates who have them
 *   anyway, which is the job a preference should do.
 * - **Mandatory means match-all, even though that can return nobody.** A vacancy naming
 *   six mandatory skills prefills a search that may match no one, and that is the honest
 *   starting point: §7.2's count-before-open exists precisely so the employer sees "0"
 *   and loosens a filter, rather than being shown a wide result set they believe is
 *   exact. Every filter here is editable, which is what §7 asks for.
 */

/** A crew is more than one person. The employer can raise it; the filter needs a floor. */
const CREW_MINIMUM = 2;

export function prefillFilters(
  aggregate: VacancyAggregate,
): CandidateSearchFilters {
  const { row, requirements } = aggregate;
  const mandatory = requirements.filter(
    (requirement) => requirement.isMandatory,
  );
  const idsOf = (fieldCode: string): string[] =>
    mandatory
      .filter((requirement) => requirement.fieldCode === fieldCode)
      .map((requirement) => requirement.itemId)
      .filter((id): id is string => id !== null);

  const skillIds = idsOf('skills');
  const skillRanks = mandatory
    .filter((requirement) => requirement.fieldCode === 'skills')
    .map((requirement) => requirement.levelRank)
    .filter((rank): rank is number => rank !== null);

  const attributeIds = [
    ...idsOf('licence_ids'),
    ...idsOf('transport_ids'),
    ...idsOf('tool_ids'),
    ...idsOf('readiness_ids'),
  ];

  const languages = mandatory
    .filter(
      (requirement) =>
        requirement.fieldCode === 'languages' && requirement.itemId !== null,
    )
    .map((requirement) => ({
      itemId: requirement.itemId as string,
      minLevelRank: requirement.levelRank ?? undefined,
    }));

  const educationLevelIds = idsOf('education_level_id');
  const specializationIds = idsOf('specialization');
  const experienceYears = valueInt(mandatory, 'experience_years_min');
  const crewRequired = mandatory.some(
    (requirement) =>
      requirement.fieldCode === 'crew_required' && requirement.valueBool,
  );

  return {
    ...(row.occupation_id ? { occupationIds: [row.occupation_id] } : {}),
    ...(row.category ? { category: row.category } : {}),

    ...(skillIds.length
      ? {
          skillIds,
          skillsMatchMode: 'all' as const,
          // The *lowest* mandatory level, not the highest: one floor has to stand for
          // per-skill levels, and demanding every skill at the strictest of them would
          // exclude candidates the vacancy would accept.
          ...(skillRanks.length
            ? { skillMinLevelRank: Math.min(...skillRanks) }
            : {}),
        }
      : {}),

    ...(languages.length ? { languages } : {}),
    ...(educationLevelIds.length ? { educationLevelIds } : {}),
    // Ids on both sides since M7, so this is a straight copy - which is the point of the
    // contract test that pins a shared field code to one meaning.
    ...(specializationIds.length ? { specializationIds } : {}),
    ...(experienceYears === null
      ? {}
      : { experienceYearsMin: experienceYears }),

    ...(row.region_id ? { regionId: row.region_id } : {}),
    ...(row.district_id ? { districtIds: [row.district_id] } : {}),
    // The point to sort around when the employer picks §7.3's proximity, carried
    // separately so that widening the district filter does not lose it.
    ...(row.district_id ? { proximityDistrictId: row.district_id } : {}),

    ...listFilter('employmentTypeIds', idsOf('employment_type_ids')),
    ...listFilter('workFormatIds', idsOf('work_format_ids')),
    ...listFilter('shiftIds', idsOf('shift_ids')),

    // The employer's ceiling, so a candidate expecting more than the vacancy pays is
    // filtered out. A negotiable vacancy states no ceiling, so it prefills none.
    ...(row.salary_is_negotiable
      ? {}
      : budget(row.salary_to ?? row.salary_from)),

    // §7.1's availability, from the date the work actually starts.
    ...(row.starts_on ? { availableBy: row.starts_on } : {}),

    ...(attributeIds.length
      ? { attributeIds, attributesMatchMode: 'all' as const }
      : {}),
    ...(crewRequired ? { crewSizeMin: CREW_MINIMUM } : {}),

    // BR-12's conditional filters come across **with their justification**, which is the
    // only way they may arrive prefilled: the vacancy's restriction was justified from
    // the same enumerated list and reviewed by a moderator (§7.1 "moderation applies").
    // Without carrying the id, UAT-06's flow would ask the employer to re-justify a
    // restriction the platform has already approved.
    ...(row.age_min === null ? {} : { ageMin: row.age_min }),
    ...(row.age_max === null ? {} : { ageMax: row.age_max }),
    ...(row.gender_id ? { genderId: row.gender_id } : {}),
    ...(row.restriction_justification_id
      ? { restrictionJustificationId: row.restriction_justification_id }
      : {}),
  };
}

function listFilter(
  key: 'employmentTypeIds' | 'workFormatIds' | 'shiftIds',
  ids: string[],
): Partial<CandidateSearchFilters> {
  return ids.length ? { [key]: ids } : {};
}

function budget(amount: string | null): Partial<CandidateSearchFilters> {
  return amount === null ? {} : { salaryMax: Number(amount) };
}

function valueInt(
  requirements: VacancyAggregate['requirements'],
  fieldCode: string,
): number | null {
  const row = requirements.find(
    (requirement) => requirement.fieldCode === fieldCode,
  );

  return row?.valueInt ?? null;
}
