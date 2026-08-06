import type { DictionaryCategory } from '@infra/db/database.types';

/**
 * The §7.1 filter set, and the weights §7.3's "overall requirement match" is made of.
 *
 * Two rules shape every filter here:
 *
 * - **Every value is a dictionary id, never a label** (BR-13, §3.3). A filter that
 *   compared text could not work identically in four interface variants, which is why
 *   §7.1's "specialization" and "remote-work readiness" are not the free-text and
 *   boolean fields they look like - see the notes on the fields that replace them.
 * - **A filter the caller did not send does not exist.** Every field is optional and an
 *   absent one contributes no predicate and no weight, so an empty request is "every
 *   searchable candidate" rather than a query with eleven inert clauses in it.
 */

/** One language requirement (§7.1: language, level, certificate availability). */
export interface LanguageFilter {
  itemId: string;
  /**
   * The rank of the lowest acceptable level, from the `language_level` dictionary.
   * A rank rather than an id because §7.1 asks for "A1-C2/native level" as a floor,
   * and a floor is a comparison - which is why the levels carry `rank` at all.
   */
  minLevelRank?: number;
  requireCertificate?: boolean;
}

export interface CandidateSearchFilters {
  // --- occupation and category -------------------------------------------
  occupationIds?: string[];
  /** Match only the candidate's *primary* occupation, not their additional ones. */
  primaryOnly?: boolean;
  category?: DictionaryCategory;
  /** §7.1's "professional level where applicable" - the primary occupation's level. */
  occupationLevelIds?: string[];

  // --- skills -------------------------------------------------------------
  skillIds?: string[];
  /**
   * §7.1's "match all or match any". `any` by default: a vacancy naming eight skills
   * would otherwise return nobody, and the employer can tighten it in one tap - which
   * is exactly what §7.2's count-before-open is for.
   */
  skillsMatchMode?: 'all' | 'any';
  /** §7.1's "proficiency", as a floor over `skill_level.rank`. */
  skillMinLevelRank?: number;

  // --- experience ---------------------------------------------------------
  experienceYearsMin?: number;
  /** §7.1's "years in the selected occupation" - needs `occupationIds` to select one. */
  occupationExperienceYearsMin?: number;
  /** §7.1's "current/last role", as the occupation of the candidate's current job. */
  currentOccupationIds?: string[];

  // --- languages ----------------------------------------------------------
  languages?: LanguageFilter[];

  // --- education ----------------------------------------------------------
  /**
   * A set of acceptable levels, not a floor: `candidate_education` stores the level's
   * id and no rank, and §7.1 asks for "education level" rather than a minimum. Adding
   * a floor later means copying the rank onto the row, as skills and languages do.
   */
  educationLevelIds?: string[];

  // --- location -----------------------------------------------------------
  regionId?: string;
  districtIds?: string[];
  willingToRelocate?: boolean;
  /**
   * §7.1 lists "travel/relocation readiness" here and "remote-work readiness" beside
   * it. Remote work is not a boolean in this data model - it is a `work_format` id, so
   * it belongs in `workFormatIds` where every other selectable value lives (BR-13).
   */
  willingToTravel?: boolean;

  // --- work preferences ---------------------------------------------------
  employmentTypeIds?: string[];
  workFormatIds?: string[];
  shiftIds?: string[];
  /** The employer's budget: a candidate expecting more than this is out. */
  salaryMax?: number;
  /** The floor of the employer's range, for a candidate whose expectation is above it. */
  salaryMin?: number;

  // --- availability -------------------------------------------------------
  /** Available on or before this calendar date (`YYYY-MM-DD`). */
  availableBy?: string;
  /** §7.1's "immediately" - the same predicate with today's date in the platform zone. */
  availableImmediately?: boolean;

  // --- physical / seasonal attributes -------------------------------------
  /** Licence, transport, tool and readiness ids - one `attribute` dictionary. */
  attributeIds?: string[];
  attributesMatchMode?: 'all' | 'any';
  crewSizeMin?: number;

  // --- profile status -----------------------------------------------------
  minCompleteness?: number;
  /** §7.1's "recently updated", against `last_meaningful_update_at`. */
  updatedSince?: string;

  // --- conditional filters (BR-12) ---------------------------------------
  ageMin?: number;
  ageMax?: number;
  genderId?: string;
  /**
   * BR-12's justification, required as soon as any of the three above is used. An id
   * from the `restriction_justification` dictionary, validated against the same
   * declaration a vacancy's restriction is validated against.
   */
  restrictionJustificationId?: string;
}

/** §7.3's sort options. */
export type CandidateSearchSort = 'match' | 'recent' | 'experience' | 'salary';

/**
 * The attribute field codes a work-attribute filter may match.
 *
 * Named here rather than at the query, because the *schema* decides them: these are
 * the `attribute`-typed multi-selects of `candidate-profile.schema.ts`, and a fifth
 * one added there needs adding here to become searchable.
 */
export const ATTRIBUTE_FIELD_CODES = [
  'licence_ids',
  'transport_ids',
  'tool_ids',
  'readiness_ids',
] as const;

/** The work-preference field codes, stored the same way (§5.1's core multi-selects). */
export const PREFERENCE_FIELD_CODES = [
  'employment_type_ids',
  'work_format_ids',
  'shift_ids',
] as const;

export type ScoreGroupCode =
  | 'occupation'
  | 'skills'
  | 'languages'
  | 'location'
  | 'preferences'
  | 'attributes';

/**
 * One group of §7.3's match score.
 *
 * `asked` is how many things the employer named in this group, and the query counts how
 * many of them the candidate has. The score is the weighted average of those ratios,
 * which is why the breakdown is worth returning: "why did this candidate rank here" is
 * the first question an employer asks, and `matched of asked` per group answers it.
 */
export interface ScoreGroup {
  code: ScoreGroupCode;
  weight: number;
  asked: number;
}

/**
 * Weights, in one place.
 *
 * Occupation and skills lead because they are what the work *is*; a language
 * requirement is usually decisive when present but there is rarely more than one;
 * location, preferences and attributes are qualifiers. These numbers are a starting
 * point rather than a tuned model - ARCHITECTURE.md §12 defers ranking ML, and a
 * rule-based score is one an employer can be shown and argue with.
 */
const WEIGHTS: Record<ScoreGroupCode, number> = {
  occupation: 3,
  skills: 3,
  languages: 2,
  location: 1,
  preferences: 1,
  attributes: 1,
};

/**
 * Which groups this request actually scores, and how much each was asked for.
 *
 * Pure, and the *only* source of both the weights and the `asked` counts: the query
 * builds its score expression by iterating this list, and the response's breakdown
 * reports the same objects. A group whose filter is absent is not in the list at all,
 * so it neither divides nor pads the average - a search for one skill and nothing else
 * scores purely on that skill.
 *
 * A group with nothing asked for is dropped rather than scored as zero: dividing by
 * `asked` needs it non-zero, and "matched none of the nothing you asked for" is not a
 * fact about the candidate.
 */
export function scoreGroups(filters: CandidateSearchFilters): ScoreGroup[] {
  const asked: Record<ScoreGroupCode, number> = {
    occupation: filters.occupationIds?.length ?? 0,
    skills: filters.skillIds?.length ?? 0,
    languages: filters.languages?.length ?? 0,
    location:
      (filters.regionId ? 1 : 0) + (filters.districtIds?.length ? 1 : 0),
    preferences:
      (filters.employmentTypeIds?.length ?? 0) +
      (filters.workFormatIds?.length ?? 0) +
      (filters.shiftIds?.length ?? 0),
    attributes: filters.attributeIds?.length ?? 0,
  };

  return (Object.keys(WEIGHTS) as ScoreGroupCode[])
    .filter((code) => asked[code] > 0)
    .map((code) => ({ code, weight: WEIGHTS[code], asked: asked[code] }));
}

/**
 * Are any of BR-12's conditional filters in use?
 *
 * §7.1 permits an age range or a gender filter "only for objectively justified and
 * legally permitted requirements", which is the same rule BR-12 puts on a vacancy. The
 * kinds are returned rather than a boolean because the justification has to cover each
 * one present - a gender filter justified by a minimum-age rule is not justified.
 */
export function restrictionKinds(
  filters: CandidateSearchFilters,
): ('age' | 'gender')[] {
  const kinds: ('age' | 'gender')[] = [];

  if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
    kinds.push('age');
  }

  if (filters.genderId) {
    kinds.push('gender');
  }

  return kinds;
}
