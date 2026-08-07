import { type RawBuilder, sql } from 'kysely';

import {
  ATTRIBUTE_FIELD_CODES,
  type CandidateSearchFilters,
  type CandidateSearchSort,
  PREFERENCE_FIELD_CODES,
  type ScoreGroup,
  type ScoreGroupCode,
} from './search-filters';

/**
 * The SQL of candidate search (§7.1, §7.2, §7.3), as fragments.
 *
 * Written as `sql` fragments rather than through the query builder, for the reason
 * `discovery.service.ts` gives and CLAUDE.md endorses: Kysely is a query builder, and
 * this is a SQL-shaped query. Eleven optional filter groups, a scoring expression, two
 * match-all semi-joins and eight correlated subqueries do not survive being expressed
 * through a fluent API without a helper typed `any`.
 *
 * Everything here is a pure function of the filters, so what each filter compiles to is
 * inspectable without a database, and the query the service runs is assembled in one
 * place instead of being spread across it.
 *
 * ARCHITECTURE.md §5's query strategy, made concrete:
 *
 * - The cheap, indexed, highly selective predicates come first: BR-02's gate is a
 *   partial index (`visibility = 'searchable' AND is_complete`), and region, category
 *   and completeness are in it.
 * - **Skills "match all" and "match any" are different plans, deliberately not
 *   unified.** Any is an `EXISTS`; all is a `GROUP BY ... HAVING count(DISTINCT ...)`.
 * - **A language floor is a rank comparison**, which is why levels carry `rank`.
 * - The expensive part - the card's aggregates - runs only for the page being returned,
 *   because filtering, scoring, sorting and the limit all happen before the join that
 *   builds the cards.
 */

/**
 * BR-02's gate, and the only predicate every read here starts from.
 *
 * §5.5's discovery has one visibility fragment behind every query so BR-04, BR-06 and
 * BR-11 cannot be forgotten; this is the same discipline for the employer's side. A
 * profile is findable when its owner asked to be found **and** it is complete - two
 * conditions, one fragment, no caller that can omit half of it.
 */
export function searchableCandidate(): RawBuilder<unknown> {
  return sql`p.visibility = 'searchable' AND p.is_complete`;
}

/**
 * Total years of work history, as a numeric expression over `candidate_experience`.
 *
 * Summed from the rows rather than stored, because nothing else needs it and a stored
 * total would go stale the moment a candidate edits a job. Two known roughnesses, both
 * acceptable and neither hidden: overlapping jobs are counted twice, and an open-ended
 * current job counts up to `today` - which is why `today` is passed in rather than being
 * `CURRENT_DATE` (in Tashkent that is yesterday for five hours a day).
 */
export function experienceYears(today: string): RawBuilder<unknown> {
  return sql`COALESCE((
    SELECT ROUND(SUM(COALESCE(ce.ended_on, ${today}::date) - ce.started_on) / 365.25, 1)
    FROM candidate_experience ce
    WHERE ce.user_id = p.user_id
  ), 0)`;
}

/** Years of history in one of the named occupations - §7.1's second experience filter. */
function occupationExperienceYears(
  today: string,
  occupationIds: string[],
): RawBuilder<unknown> {
  return sql`COALESCE((
    SELECT ROUND(SUM(COALESCE(ce.ended_on, ${today}::date) - ce.started_on) / 365.25, 1)
    FROM candidate_experience ce
    WHERE ce.user_id = p.user_id AND ce.occupation_id = ANY(${occupationIds}::uuid[])
  ), 0)`;
}

/**
 * Every §7.1 filter the caller sent, as one predicate.
 *
 * `today` is the platform-zone calendar date (CLAUDE.md: never `toISOString().slice`),
 * and it is what makes "available immediately" and an age range mean the same thing to
 * every replica.
 */
export function whereFilters(
  filters: CandidateSearchFilters,
  today: string,
): RawBuilder<unknown> {
  const conditions: RawBuilder<unknown>[] = [searchableCandidate()];

  // --- occupation and category -------------------------------------------
  if (filters.occupationIds?.length) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_occupations co
      WHERE co.user_id = p.user_id
        AND co.item_id = ANY(${filters.occupationIds}::uuid[])
        ${filters.primaryOnly ? sql`AND co.is_primary` : sql``}
    )`);
  }

  if (filters.category) {
    conditions.push(sql`p.category = ${filters.category}::dictionary_category`);
  }

  if (filters.occupationLevelIds?.length) {
    // The level of the *primary* occupation: §7.1's "professional level where
    // applicable" is a property of the work the candidate is targeting, and an
    // additional occupation's level would answer a question nobody asked.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_occupations co
      WHERE co.user_id = p.user_id AND co.is_primary
        AND co.level_id = ANY(${filters.occupationLevelIds}::uuid[])
    )`);
  }

  // --- skills -------------------------------------------------------------
  if (filters.skillIds?.length) {
    const rank = filters.skillMinLevelRank;
    const level =
      rank === undefined ? sql`` : sql`AND cs.level_rank >= ${rank}`;

    if (filters.skillsMatchMode === 'all') {
      // Every named skill, at the required level. A different plan from `any`, and
      // ARCHITECTURE.md §5 asks for both rather than one clever query that does neither
      // well.
      conditions.push(sql`(
        SELECT count(DISTINCT cs.item_id) FROM candidate_skills cs
        WHERE cs.user_id = p.user_id
          AND cs.item_id = ANY(${filters.skillIds}::uuid[]) ${level}
      ) = ${filters.skillIds.length}`);
    } else {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM candidate_skills cs
        WHERE cs.user_id = p.user_id
          AND cs.item_id = ANY(${filters.skillIds}::uuid[]) ${level}
      )`);
    }
  }

  // --- experience ---------------------------------------------------------
  if (filters.experienceYearsMin !== undefined) {
    conditions.push(
      sql`${experienceYears(today)} >= ${filters.experienceYearsMin}`,
    );
  }

  if (
    filters.occupationExperienceYearsMin !== undefined &&
    filters.occupationIds?.length
  ) {
    conditions.push(
      sql`${occupationExperienceYears(today, filters.occupationIds)} >= ${filters.occupationExperienceYearsMin}`,
    );
  }

  if (filters.currentOccupationIds?.length) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_experience ce
      WHERE ce.user_id = p.user_id AND ce.is_current
        AND ce.occupation_id = ANY(${filters.currentOccupationIds}::uuid[])
    )`);
  }

  // --- languages ----------------------------------------------------------
  // One predicate per language, ANDed: "Russian C1 and English B2" is two
  // requirements, not a set the candidate may satisfy either half of. UAT-06's
  // controlled example is exactly this filter.
  for (const language of filters.languages ?? []) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_languages cl
      WHERE cl.user_id = p.user_id AND cl.item_id = ${language.itemId}::uuid
        ${
          language.minLevelRank === undefined
            ? sql``
            : sql`AND cl.level_rank >= ${language.minLevelRank}`
        }
        ${language.requireCertificate ? sql`AND cl.has_certificate` : sql``}
    )`);
  }

  // --- education ----------------------------------------------------------
  if (filters.educationLevelIds?.length) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_education ced
      WHERE ced.user_id = p.user_id
        AND ced.level_id = ANY(${filters.educationLevelIds}::uuid[])
    )`);
  }

  if (filters.specializationIds?.length) {
    // An attribute row per specialization, like every other dictionary multi-select on
    // the profile - which is what makes this an indexed join rather than the substring
    // match it was before M7.
    conditions.push(attributeAny('specialization', filters.specializationIds));
  }

  // --- location -----------------------------------------------------------
  if (filters.regionId) {
    conditions.push(sql`p.region_id = ${filters.regionId}::uuid`);
  }

  if (filters.districtIds?.length) {
    conditions.push(sql`p.district_id = ANY(${filters.districtIds}::uuid[])`);
  }

  if (filters.willingToRelocate) {
    conditions.push(sql`p.willing_to_relocate IS TRUE`);
  }

  if (filters.willingToTravel) {
    conditions.push(sql`p.willing_to_travel IS TRUE`);
  }

  // --- work preferences ---------------------------------------------------
  for (const [fieldCode, ids] of [
    ['employment_type_ids', filters.employmentTypeIds],
    ['work_format_ids', filters.workFormatIds],
    ['shift_ids', filters.shiftIds],
  ] as const) {
    if (ids?.length) {
      conditions.push(attributeAny(fieldCode, ids));
    }
  }

  // A negotiable expectation passes a budget, for the reason the vacancy feed gives in
  // reverse: the candidate has not said no to the figure, and excluding them would hide
  // most of the seasonal work this product exists for.
  if (filters.salaryMax !== undefined) {
    conditions.push(sql`(
      p.salary_is_negotiable OR p.salary_from IS NULL
      OR p.salary_from <= ${filters.salaryMax}
    )`);
  }

  if (filters.salaryMin !== undefined) {
    conditions.push(sql`(
      p.salary_is_negotiable OR p.salary_to IS NULL
      OR p.salary_to >= ${filters.salaryMin}
    )`);
  }

  // --- availability -------------------------------------------------------
  const availableBy = filters.availableImmediately
    ? today
    : filters.availableBy;

  if (availableBy) {
    // No date on the profile means "no constraint stated", which is available now.
    conditions.push(
      sql`(p.available_from IS NULL OR p.available_from <= ${availableBy}::date)`,
    );
  }

  // --- physical / seasonal attributes -------------------------------------
  if (filters.attributeIds?.length) {
    if (filters.attributesMatchMode === 'all') {
      conditions.push(sql`(
        SELECT count(DISTINCT ca.item_id) FROM candidate_attributes ca
        WHERE ca.user_id = p.user_id
          AND ca.field_code = ANY(${[...ATTRIBUTE_FIELD_CODES]}::text[])
          AND ca.item_id = ANY(${filters.attributeIds}::uuid[])
      ) = ${filters.attributeIds.length}`);
    } else {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM candidate_attributes ca
        WHERE ca.user_id = p.user_id
          AND ca.field_code = ANY(${[...ATTRIBUTE_FIELD_CODES]}::text[])
          AND ca.item_id = ANY(${filters.attributeIds}::uuid[])
      )`);
    }
  }

  if (filters.crewSizeMin !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM candidate_attributes ca
      WHERE ca.user_id = p.user_id AND ca.field_code = 'crew_size'
        AND ca.value_int >= ${filters.crewSizeMin}
    )`);
  }

  // --- profile status -----------------------------------------------------
  if (filters.minCompleteness !== undefined) {
    conditions.push(sql`p.completeness_percent >= ${filters.minCompleteness}`);
  }

  if (filters.updatedSince) {
    conditions.push(
      sql`p.last_meaningful_update_at >= ${filters.updatedSince}::date`,
    );
  }

  // --- conditional filters (BR-12) ---------------------------------------
  // Permitted only with a justification, which the service validates before getting
  // here. Age is derived from the birth date rather than stored, so the comparison runs
  // the other way round: at least 30 means born on or before today minus 30 years.
  if (filters.ageMin !== undefined) {
    conditions.push(
      sql`p.date_of_birth <= (${today}::date - make_interval(years => ${filters.ageMin}))`,
    );
  }

  if (filters.ageMax !== undefined) {
    // Strictly after, so somebody who turns `ageMax + 1` tomorrow still qualifies today.
    conditions.push(
      sql`p.date_of_birth > (${today}::date - make_interval(years => ${filters.ageMax + 1}))`,
    );
  }

  if (filters.genderId) {
    conditions.push(sql`p.gender_id = ${filters.genderId}::uuid`);
  }

  return sql.join(conditions, sql` AND `);
}

/** One work-preference or attribute multi-select, matched on any of the chosen ids. */
function attributeAny(
  fieldCode: string,
  ids: readonly string[],
): RawBuilder<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM candidate_attributes ca
    WHERE ca.user_id = p.user_id AND ca.field_code = ${fieldCode}
      AND ca.item_id = ANY(${[...ids]}::uuid[])
  )`;
}

/**
 * How many of the group's asked-for items this candidate has, per active group.
 *
 * Selected as columns of their own so the score and the response's breakdown are the
 * same numbers, and so each subquery is evaluated once rather than once per use.
 */
export function matchedColumns(
  filters: CandidateSearchFilters,
  groups: ScoreGroup[],
): RawBuilder<unknown>[] {
  return groups.map(
    (group) =>
      sql`${matchedExpression(filters, group.code)} AS ${sql.raw(`matched_${group.code}`)}`,
  );
}

function matchedExpression(
  filters: CandidateSearchFilters,
  code: ScoreGroupCode,
): RawBuilder<unknown> {
  switch (code) {
    case 'occupation':
      return sql`(
        SELECT count(DISTINCT co.item_id) FROM candidate_occupations co
        WHERE co.user_id = p.user_id
          AND co.item_id = ANY(${filters.occupationIds ?? []}::uuid[])
      )`;
    case 'skills':
      return sql`(
        SELECT count(DISTINCT cs.item_id) FROM candidate_skills cs
        WHERE cs.user_id = p.user_id
          AND cs.item_id = ANY(${filters.skillIds ?? []}::uuid[])
          ${
            filters.skillMinLevelRank === undefined
              ? sql``
              : sql`AND cs.level_rank >= ${filters.skillMinLevelRank}`
          }
      )`;
    case 'languages':
      // Each language is satisfied or not, at its own level - so this counts
      // requirements met, not rows. A candidate with Russian B1 against a C1
      // requirement has met none of them.
      return sql`(
        SELECT count(*) FROM candidate_languages cl
        WHERE cl.user_id = p.user_id AND (${sql.join(
          (filters.languages ?? []).map(
            (language) => sql`(
              cl.item_id = ${language.itemId}::uuid
              ${
                language.minLevelRank === undefined
                  ? sql``
                  : sql`AND cl.level_rank >= ${language.minLevelRank}`
              }
              ${language.requireCertificate ? sql`AND cl.has_certificate` : sql``}
            )`,
          ),
          sql` OR `,
        )})
      )`;
    case 'specialization':
      return sql`(
        SELECT count(DISTINCT ca.item_id) FROM candidate_attributes ca
        WHERE ca.user_id = p.user_id AND ca.field_code = 'specialization'
          AND ca.item_id = ANY(${filters.specializationIds ?? []}::uuid[])
      )`;
    case 'location':
      return sql`(
        (CASE WHEN ${filters.regionId ?? null}::uuid IS NOT NULL
              AND p.region_id = ${filters.regionId ?? null}::uuid THEN 1 ELSE 0 END)
        + (CASE WHEN p.district_id = ANY(${filters.districtIds ?? []}::uuid[]) THEN 1 ELSE 0 END)
      )`;
    case 'preferences':
      return sql`(
        SELECT count(DISTINCT ca.item_id) FROM candidate_attributes ca
        WHERE ca.user_id = p.user_id
          AND ca.field_code = ANY(${[...PREFERENCE_FIELD_CODES]}::text[])
          AND ca.item_id = ANY(${[
            ...(filters.employmentTypeIds ?? []),
            ...(filters.workFormatIds ?? []),
            ...(filters.shiftIds ?? []),
          ]}::uuid[])
      )`;
    default:
      return sql`(
        SELECT count(DISTINCT ca.item_id) FROM candidate_attributes ca
        WHERE ca.user_id = p.user_id
          AND ca.field_code = ANY(${[...ATTRIBUTE_FIELD_CODES]}::text[])
          AND ca.item_id = ANY(${filters.attributeIds ?? []}::uuid[])
      )`;
  }
}

/**
 * §7.3's "overall requirement match", as a percentage.
 *
 * The weighted average of each active group's `matched / asked`, over the groups the
 * employer actually filtered on. `LEAST` caps a group at what was asked for, so a
 * candidate who lists a superset cannot score above 100.
 *
 * With no filters at all there is nothing to have matched, and every searchable
 * candidate matches the nothing that was asked - so the score is 100 for everyone and
 * the sort falls through to its tiebreaker. That is honest; scoring an unfiltered search
 * out of zero would be a division by zero dressed up as information.
 */
export function scoreExpression(groups: ScoreGroup[]): RawBuilder<unknown> {
  if (groups.length === 0) {
    return sql`100`;
  }

  const weightTotal = groups.reduce((sum, group) => sum + group.weight, 0);
  const terms = groups.map(
    (group) =>
      sql`${group.weight} * LEAST(${sql.raw(`m.matched_${group.code}`)}, ${group.asked})::numeric / ${group.asked}`,
  );

  return sql`ROUND(100 * (${sql.join(terms, sql` + `)}) / ${weightTotal})`;
}

/**
 * §7.3's "location proximity", as tiers rather than a distance.
 *
 * Same district counts 2, the same region 1, anywhere else 0 - measured against
 * `proximityDistrictId`, or the first filtered district if the caller did not name one.
 * The region tier is that district's *parent*, read from the dictionary tree, so the
 * caller supplies one id rather than two that could disagree.
 *
 * **Why tiers and not kilometres.** A place is a dictionary id in a two-level tree here;
 * there are no coordinates on a candidate, a vacancy or a district. A distance computed
 * from that tree would be a number nobody measured, presented in a control an employer
 * would read as real. Tiers are exactly what the data supports, and adding a centroid per
 * district later turns this into a real distance without changing the contract.
 *
 * **The reference point is deliberately not the district filter.** Filtering by district
 * excludes everyone who is not in it, which would leave a proximity sort with nothing to
 * order. The useful shape is a wide filter and a point to sort around - a region filter,
 * or none at all, plus the vacancy's district.
 *
 * With no reference at all there is nothing to be near, so everyone scores 0 and the sort
 * falls through to its tiebreaker: documented rather than refused, because the result set
 * is identical either way and only the order within it is undefined.
 */
export function proximityRank(
  filters: CandidateSearchFilters,
): RawBuilder<unknown> {
  const near = filters.proximityDistrictId ?? filters.districtIds?.[0] ?? null;

  return sql`(
    (CASE WHEN p.district_id = ${near}::uuid THEN 2 ELSE 0 END)
    + (CASE WHEN p.region_id = COALESCE(
          (SELECT di.parent_id FROM dictionary_items di WHERE di.id = ${near}::uuid),
          ${filters.regionId ?? null}::uuid
        ) THEN 1 ELSE 0 END)
  )`;
}

/**
 * The per-group counts as one JSON column.
 *
 * One column rather than one per group, because which groups exist depends on the
 * request - and a row type with a variable set of columns is a row type that cannot be
 * checked. The breakdown the client reads is these counts against `scoreGroups()`'
 * `asked`, so the number that ranked a candidate and the number shown to explain it are
 * the same number.
 */
export function matchedJson(groups: ScoreGroup[]): RawBuilder<unknown> {
  if (groups.length === 0) {
    return sql`'{}'::json`;
  }

  // The key is a literal rather than a bound parameter: `json_build_object` gives
  // Postgres nothing to infer a parameter's type from, and the group codes are a closed
  // union in this file's own types - never client input.
  const pairs = groups.map(
    (group) =>
      sql`${sql.lit(group.code)}, LEAST(${sql.raw(`r.matched_${group.code}`)}, ${group.asked})`,
  );

  return sql`json_build_object(${sql.join(pairs, sql`, `)})`;
}

/**
 * §7.3's candidate card.
 *
 * **No phone number, and none is even selected.** §11.1: "Phone number and full contact
 * details are not shown in general candidate search cards." Nulling one afterwards would
 * leave the value one careless serializer away from a client; not joining `users` at all
 * means there is nothing to leak. Contact details belong to the profile view, where
 * BR-09 can be evaluated against a real interaction.
 *
 * `photoFileId` is the one exception to files being BR-09-gated, argued in the service.
 *
 * The three relationship columns save the client a round trip per card, the way the
 * candidate's feed carries `isSaved` and `applicationStatus`: an employer looking at a
 * result needs to know whether they already saved this person, already shortlisted them
 * for this vacancy, and whether the candidate has applied to them.
 */
export function cardColumns(
  employerUserId: string,
  vacancyId: string | null,
): RawBuilder<unknown> {
  return sql`
    p.user_id, p.full_name, p.region_id, p.district_id, p.settlement, p.category,
    p.salary_from, p.salary_to, p.salary_period_id, p.salary_is_negotiable,
    p.available_from, p.completeness_percent, p.last_meaningful_update_at,
    po.item_id AS primary_occupation_id,
    po.level_id AS primary_occupation_level_id,
    cur.role_title AS current_role_title,
    cur.occupation_id AS current_occupation_id,
    r.experience_years,
    r.match_score,
    -- §7.3's "key skills": the strongest ten, not the whole list, which is what a card
    -- has room for. The profile view returns all of them.
    (SELECT json_agg(s) FROM (
      SELECT cs.item_id AS "itemId", cs.level_id AS "levelId", cs.level_rank AS "levelRank"
      FROM candidate_skills cs WHERE cs.user_id = p.user_id
      ORDER BY cs.level_rank DESC LIMIT 10
    ) s) AS skills,
    (SELECT json_agg(l) FROM (
      SELECT cl.item_id AS "itemId", cl.level_id AS "levelId",
        cl.level_rank AS "levelRank", cl.has_certificate AS "hasCertificate"
      FROM candidate_languages cl WHERE cl.user_id = p.user_id
      ORDER BY cl.level_rank DESC
    ) l) AS languages,
    (
      SELECT sf.id FROM stored_files sf
      JOIN dictionary_items di ON di.id = sf.purpose_id
      WHERE sf.owner_user_id = p.user_id AND sf.deleted_at IS NULL AND di.code = 'photo'
      ORDER BY sf.created_at DESC LIMIT 1
    ) AS photo_file_id,
    sc.candidate_user_id IS NOT NULL AS is_saved,
    sc.note AS note,
    ${
      vacancyId === null
        ? sql`false`
        : sql`EXISTS (
            SELECT 1 FROM vacancy_shortlists vs
            WHERE vs.vacancy_id = ${vacancyId}::uuid AND vs.candidate_user_id = p.user_id
          )`
    } AS is_shortlisted,
    (
      SELECT a.status FROM applications a
      JOIN vacancies v ON v.id = a.vacancy_id
      WHERE v.employer_user_id = ${employerUserId} AND a.candidate_user_id = p.user_id
      ORDER BY a.created_at DESC LIMIT 1
    ) AS application_status
  `;
}

/** The joins `cardColumns` reads from, past the ranked page. */
export function cardJoins(employerUserId: string): RawBuilder<unknown> {
  return sql`
    JOIN candidate_profiles p ON p.user_id = r.user_id
    LEFT JOIN candidate_occupations po ON po.user_id = p.user_id AND po.is_primary
    LEFT JOIN saved_candidates sc
      ON sc.candidate_user_id = p.user_id AND sc.employer_user_id = ${employerUserId}
    -- The current job, or the most recent one if none is current - §7.3's "experience"
    -- and §7.1's "current/last role" are the same row.
    LEFT JOIN LATERAL (
      SELECT ce.role_title, ce.occupation_id FROM candidate_experience ce
      WHERE ce.user_id = p.user_id
      ORDER BY ce.is_current DESC, ce.started_on DESC LIMIT 1
    ) cur ON TRUE
  `;
}

/**
 * §7.3's sort options, applied to the aliased row `r`.
 *
 * Every option ends with the same two tiebreakers, and that is not cosmetic: without a
 * total order, two pages of a paginated search can repeat or skip a candidate.
 */
export function orderBy(sort: CandidateSearchSort): RawBuilder<unknown> {
  const primary: Record<CandidateSearchSort, RawBuilder<unknown>> = {
    match: sql`r.match_score DESC`,
    recent: sql`r.last_meaningful_update_at DESC NULLS LAST`,
    experience: sql`r.experience_years DESC`,
    // Cheapest expectation first: an employer sorting by expected pay is looking at a
    // budget. A candidate who stated none sorts last rather than as free.
    salary: sql`r.salary_from ASC NULLS LAST`,
    // Nearest tier first (§7.3). Ties inside a tier fall to recency, which is the most
    // useful second key when everyone is equally near.
    proximity: sql`r.proximity_rank DESC`,
  };

  return sql`${primary[sort]}, r.last_meaningful_update_at DESC NULLS LAST, r.user_id`;
}
