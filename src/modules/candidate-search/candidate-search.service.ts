import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type RawBuilder, sql } from 'kysely';

import {
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { DictionaryCategory } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { formatDateOnly } from '@infra/time/format';
import { EmployersService } from '@modules/employers/employers.service';
import { isJustificationValid } from '@modules/vacancies/age-gender-justifications';
import { loadVacancy } from '@modules/vacancies/vacancy-state';

import {
  type CandidateSearchFilters,
  type CandidateSearchSort,
  type ScoreGroup,
  restrictionKinds,
  scoreGroups,
} from './search-filters';
import { prefillFilters } from './search-prefill';
import {
  cardColumns,
  cardJoins,
  experienceYears,
  matchedColumns,
  matchedJson,
  orderBy,
  proximityRank,
  scoreExpression,
  whereFilters,
} from './search-query';

export interface CandidateSkillCard {
  itemId: string;
  levelId: string;
  levelRank: number;
}

export interface CandidateLanguageCard extends CandidateSkillCard {
  hasCertificate: boolean;
}

/** §7.3's candidate card. No contact details - see the class comment. */
export interface CandidateCard {
  candidateUserId: string;
  fullName: string | null;
  regionId: string | null;
  districtId: string | null;
  settlement: string | null;
  category: DictionaryCategory | null;
  primaryOccupationId: string | null;
  occupationLevelId: string | null;
  currentRoleTitle: string | null;
  currentOccupationId: string | null;
  experienceYears: number;
  skills: CandidateSkillCard[];
  languages: CandidateLanguageCard[];
  salaryFrom: number | null;
  salaryTo: number | null;
  salaryPeriodId: string | null;
  salaryIsNegotiable: boolean;
  availableFrom: string | null;
  completenessPercent: number;
  lastMeaningfulUpdateAt: Date | null;
  /** `GET` path for the profile photo, or null when there is none (§7.3). */
  photoPath: string | null;
  isSaved: boolean;
  /** The employer's own private note on this candidate (§7.3), if they wrote one. */
  note: string | null;
  /** Only meaningful with a vacancy context, and false without one. */
  isShortlisted: boolean;
  /** The candidate's stage on any of this employer's vacancies, or null (§6.5). */
  applicationStatus: string | null;
  /**
   * The invitation occupying BR-07's slot for *this* search's vacancy, or null.
   *
   * Deliberately not "have I ever invited them": the slot is per vacancy, so an employer
   * who invited this candidate elsewhere may still invite them here.
   */
  invitationStatus: string | null;
  matchScore: number;
  matchBreakdown: {
    group: string;
    weight: number;
    asked: number;
    matched: number;
  }[];
}

export interface CandidateSearchRequest {
  filters: CandidateSearchFilters;
  sort: CandidateSearchSort;
  limit: number;
  offset: number;
  /**
   * The vacancy the search was opened from (UAT-06). Only decides the shortlist flag on
   * the card - the filters were prefilled by a separate call and are the client's to
   * edit, so the search itself must not re-read the vacancy behind their back.
   */
  vacancyId?: string;
}

interface CardRow {
  user_id: string;
  full_name: string | null;
  region_id: string | null;
  district_id: string | null;
  settlement: string | null;
  category: DictionaryCategory | null;
  primary_occupation_id: string | null;
  primary_occupation_level_id: string | null;
  current_role_title: string | null;
  current_occupation_id: string | null;
  experience_years: string;
  skills: CandidateSkillCard[] | null;
  languages: CandidateLanguageCard[] | null;
  salary_from: string | null;
  salary_to: string | null;
  salary_period_id: string | null;
  salary_is_negotiable: boolean;
  available_from: string | null;
  completeness_percent: number;
  last_meaningful_update_at: Date | null;
  photo_file_id: string | null;
  is_saved: boolean;
  note: string | null;
  is_shortlisted: boolean;
  application_status: string | null;
  invitation_status: string | null;
  match_score: string;
  matched: Record<string, number>;
}

/**
 * Employer-facing structured candidate search (§7), its saves and its shortlists (§7.3).
 *
 * A separate module from `discovery` on purpose (ARCHITECTURE.md §2): both are "search",
 * and they have different authorization, different filters and different ranking.
 * Merging them produces a permission-shaped mess - and the permission here is the strict
 * one, so it is worth stating plainly what this class holds:
 *
 * - **Only a verified employer may search at all** (§7, BR-03). Every public method
 *   starts with `assertVerified`, including the saved list and the shortlists: an
 *   employer whose verification is revoked loses the candidate database, not just the
 *   search box.
 * - **Every read starts from BR-02's gate** - `searchableCandidate()`, one fragment, the
 *   same discipline M6's discovery uses for BR-04/BR-06/BR-11. It applies to the saved
 *   list too, which is a deliberate answer to a real question: a candidate who hides
 *   their profile disappears from the lists of employers who saved them earlier.
 *   Otherwise "hide me from search" would be defeated by anyone who got there first. The
 *   save itself survives, so they reappear if they choose to.
 * - **A card carries no contact details** (§11.1), and BR-09 is not consulted to decide
 *   it: a card is not a hiring interaction, whatever else exists between these two
 *   people, so the answer is fixed. The query does not join `users` at all, which is
 *   stronger than fetching a phone number and nulling it - there is nothing in the row to
 *   forget to remove, and `candidate-search.query.spec.ts` asserts that mechanically. The
 *   profile view is where a real interaction can change the answer, and it goes through
 *   the one BR-09 gatherer in `CandidateViewService`.
 *
 * The one exception to files being BR-09-gated is the **profile photo**, and it is narrow
 * by construction: only the file whose purpose is `photo`, only for a candidate who is
 * searchable, only to a verified employer. §7.3 puts a photo on the candidate card, and a
 * photo a candidate uploaded to be found by is not the "authorized CV" of §5.4. Treating
 * it as one would make §7.3 unimplementable; treating *any* file this way would make
 * BR-09 pointless. This is the seam, and it is one route with one purpose check.
 */
@Injectable()
export class CandidateSearchService {
  private readonly logger = new Logger(CandidateSearchService.name);
  private readonly timeZone: string;
  /**
   * How far §7.2's count counts before answering "n+".
   *
   * Counting a set of 40 000 exactly, so a screen can render "40 000", costs a full scan
   * for a number nobody acts on; "200+" answers the question the employer is actually
   * asking, which is whether to narrow the filters before opening the list.
   */
  private readonly countCap: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly employers: EmployersService,
    private readonly files: FilesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
    this.countCap = config.get('SEARCH_COUNT_CAP', { infer: true });
  }

  /** §7.1's filters, §7.3's ranking and card. */
  async search(
    employerUserId: string,
    request: CandidateSearchRequest,
  ): Promise<{ items: CandidateCard[]; groups: ScoreGroup[] }> {
    await this.employers.assertVerified(employerUserId);
    await this.assertFiltersPermitted(employerUserId, request.filters);

    const groups = scoreGroups(request.filters);
    const rows = await this.page(employerUserId, request, groups);

    return { items: rows.map((row) => this.toCard(row, groups)), groups };
  }

  /**
   * §7.2's count-before-open.
   *
   * A separate, much cheaper query than `search`: no cards, no aggregates, no sort - and
   * bounded, so a filter set matching everyone costs the same as one matching nobody.
   * `isExact` is what lets the client render "200+" honestly rather than showing a
   * rounded number as though it were the truth.
   */
  async count(
    employerUserId: string,
    filters: CandidateSearchFilters,
  ): Promise<{ count: number; isExact: boolean }> {
    await this.employers.assertVerified(employerUserId);
    await this.assertFiltersPermitted(employerUserId, filters);

    const today = formatDateOnly(new Date(), this.timeZone);
    const result = await sql<{ count: string }>`
      SELECT count(*) AS count FROM (
        SELECT 1 FROM candidate_profiles p
        WHERE ${whereFilters(filters, today, this.timeZone)}
        LIMIT ${this.countCap + 1}
      ) bounded
    `.execute(this.db);

    const counted = Number(result.rows[0]?.count ?? 0);

    return counted > this.countCap
      ? { count: this.countCap, isExact: false }
      : { count: counted, isExact: true };
  }

  /** UAT-06: the vacancy's requirements as an editable filter set (§7). */
  async prefill(
    employerUserId: string,
    vacancyId: string,
  ): Promise<CandidateSearchFilters> {
    await this.employers.assertVerified(employerUserId);

    const aggregate = await loadVacancy(this.db, vacancyId);

    // 404 rather than 403 for another employer's vacancy, as everywhere else: an
    // employer must not learn that an id exists (§11.1).
    if (!aggregate || aggregate.row.employer_user_id !== employerUserId) {
      throw new NotFoundError('vacancy.not_found');
    }

    return prefillFilters(aggregate);
  }

  /** §7.3's Save. Idempotent by primary key - saving twice is saving once. */
  async save(employerUserId: string, candidateUserId: string): Promise<void> {
    await this.employers.assertVerified(employerUserId);
    await this.assertFindable(candidateUserId);

    await this.db
      .insertInto('saved_candidates')
      .values({
        employer_user_id: employerUserId,
        candidate_user_id: candidateUserId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unsave(employerUserId: string, candidateUserId: string): Promise<void> {
    await this.employers.assertVerified(employerUserId);

    await this.db
      .deleteFrom('saved_candidates')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .execute();
  }

  /**
   * §7.3's "private employer note".
   *
   * Written on the save, so a note cannot exist without one - and saving is what the
   * note is *about*. Private is structural: nothing candidate-facing reads this table.
   */
  async setNote(
    employerUserId: string,
    candidateUserId: string,
    note: string | null,
  ): Promise<void> {
    await this.employers.assertVerified(employerUserId);
    await this.assertFindable(candidateUserId);

    await this.db
      .insertInto('saved_candidates')
      .values({
        employer_user_id: employerUserId,
        candidate_user_id: candidateUserId,
        note,
      })
      .onConflict((oc) =>
        oc
          .columns(['employer_user_id', 'candidate_user_id'])
          .doUpdateSet({ note, updated_at: sql`now()` }),
      )
      .execute();
  }

  /** The employer's saved candidates, as the same cards search returns (§7.3). */
  async listSaved(
    employerUserId: string,
    limit: number,
    offset: number,
  ): Promise<CandidateCard[]> {
    await this.employers.assertVerified(employerUserId);

    return this.list(
      employerUserId,
      null,
      sql`EXISTS (
        SELECT 1 FROM saved_candidates sc
        WHERE sc.candidate_user_id = p.user_id
          AND sc.employer_user_id = ${employerUserId}
      )`,
      limit,
      offset,
    );
  }

  /** §7.3: a saved candidate attached to one vacancy's shortlist. */
  async shortlist(
    employerUserId: string,
    vacancyId: string,
    candidateUserId: string,
  ): Promise<void> {
    await this.employers.assertVerified(employerUserId);
    await this.assertOwnsVacancy(employerUserId, vacancyId);
    await this.assertFindable(candidateUserId);

    await this.db
      .insertInto('vacancy_shortlists')
      .values({ vacancy_id: vacancyId, candidate_user_id: candidateUserId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unshortlist(
    employerUserId: string,
    vacancyId: string,
    candidateUserId: string,
  ): Promise<void> {
    await this.employers.assertVerified(employerUserId);
    await this.assertOwnsVacancy(employerUserId, vacancyId);

    await this.db
      .deleteFrom('vacancy_shortlists')
      .where('vacancy_id', '=', vacancyId)
      .where('candidate_user_id', '=', candidateUserId)
      .execute();
  }

  async listShortlist(
    employerUserId: string,
    vacancyId: string,
    limit: number,
    offset: number,
  ): Promise<CandidateCard[]> {
    await this.employers.assertVerified(employerUserId);
    await this.assertOwnsVacancy(employerUserId, vacancyId);

    return this.list(
      employerUserId,
      vacancyId,
      sql`EXISTS (
        SELECT 1 FROM vacancy_shortlists vs
        WHERE vs.candidate_user_id = p.user_id AND vs.vacancy_id = ${vacancyId}::uuid
      )`,
      limit,
      offset,
    );
  }

  /**
   * The bytes of a candidate's profile photo (§7.3's "photo if allowed").
   *
   * The narrow exception to BR-09's file gate, and every part of it is checked here: the
   * caller is a verified employer, the candidate is findable, and the file is the one
   * whose purpose is `photo`. Nothing else the candidate uploaded is reachable this way -
   * a CV still needs an application or an accepted invitation.
   */
  async photo(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    await this.employers.assertVerified(employerUserId);
    await this.assertFindable(candidateUserId);

    const row = await this.db
      .selectFrom('stored_files')
      .innerJoin(
        'dictionary_items',
        'dictionary_items.id',
        'stored_files.purpose_id',
      )
      .select('stored_files.id')
      .where('stored_files.owner_user_id', '=', candidateUserId)
      .where('stored_files.deleted_at', 'is', null)
      .where('dictionary_items.code', '=', 'photo')
      .orderBy('stored_files.created_at', 'desc')
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('file.not_found');
    }

    return this.files.readAsAuthorized(candidateUserId, row.id);
  }

  /** One page of cards for a scope that is not a filter set - saved, or a shortlist. */
  private async list(
    employerUserId: string,
    vacancyId: string | null,
    scope: RawBuilder<unknown>,
    limit: number,
    offset: number,
  ): Promise<CandidateCard[]> {
    const rows = await this.page(
      employerUserId,
      {
        filters: {},
        sort: 'recent',
        limit,
        offset,
        ...(vacancyId ? { vacancyId } : {}),
      },
      [],
      scope,
    );

    return rows.map((row) => this.toCard(row, []));
  }

  /**
   * The one query behind every list of cards.
   *
   * Four stages, in this order for a reason: `matched` filters and counts, `scored`
   * turns the counts into §7.3's percentage, `ranked` sorts and takes the page, and only
   * then does the outer select build the cards. Nine correlated subqueries and two
   * lateral joins run for at most `limit` candidates rather than for every match, which
   * is what keeps the 3-second budget (§12.4) a matter of the filters rather than of the
   * size of the database.
   */
  private async page(
    employerUserId: string,
    request: CandidateSearchRequest,
    groups: ScoreGroup[],
    scope?: RawBuilder<unknown>,
  ): Promise<CardRow[]> {
    const today = formatDateOnly(new Date(), this.timeZone);
    const where = scope
      ? sql`${whereFilters(request.filters, today, this.timeZone)} AND ${scope}`
      : whereFilters(request.filters, today, this.timeZone);
    const matched = matchedColumns(request.filters, groups).map(
      (column) => sql`, ${column}`,
    );

    const result = await sql<CardRow>`
      WITH matched AS (
        SELECT p.user_id, p.last_meaningful_update_at, p.salary_from,
          ${experienceYears(today)} AS experience_years,
          ${proximityRank(request.filters)} AS proximity_rank
          ${sql.join(matched, sql``)}
        FROM candidate_profiles p
        WHERE ${where}
      ),
      scored AS (
        SELECT m.*, ${scoreExpression(groups)} AS match_score FROM matched m
      ),
      ranked AS (
        SELECT r.* FROM scored r
        ORDER BY ${orderBy(request.sort)}
        LIMIT ${request.limit} OFFSET ${request.offset}
      )
      SELECT ${cardColumns(employerUserId, request.vacancyId ?? null)},
        ${matchedJson(groups)} AS matched
      FROM ranked r
      ${cardJoins(employerUserId)}
      ORDER BY ${orderBy(request.sort)}
    `.execute(this.db);

    return result.rows;
  }

  /**
   * BR-12 on the search side (§7.1's "conditional filters").
   *
   * An age or gender filter needs a justification from the same enumerated list a
   * vacancy's restriction needs, and it must cover every kind of restriction present -
   * the identical rule, from the identical module, because "objectively justified" cannot
   * mean one thing when publishing and another when searching.
   *
   * Every use is logged. §7.1 says "moderation applies", and a search cannot be moderated
   * before it runs; what it can do is leave a record for the audit log M10 builds, so a
   * pattern of restricted searches is visible after the fact.
   */
  private async assertFiltersPermitted(
    employerUserId: string,
    filters: CandidateSearchFilters,
  ): Promise<void> {
    if (
      filters.occupationExperienceYearsMin !== undefined &&
      !filters.occupationIds?.length
    ) {
      throw new ForbiddenError('search.occupation_required');
    }

    const kinds = restrictionKinds(filters);

    if (kinds.length === 0) {
      return;
    }

    const code = await this.justificationCodeOf(
      filters.restrictionJustificationId,
    );

    if (!code || !isJustificationValid(code, kinds)) {
      throw new ForbiddenError('search.restriction_not_justified');
    }

    this.logger.warn(
      `Employer ${employerUserId} searched with a ${kinds.join('+')} restriction, ` +
        `justified as ${code}`,
    );
  }

  /**
   * The justification's code, resolved from its dictionary id.
   *
   * The twin of `VacanciesService.justificationCodeOf`, deliberately duplicated once:
   * two small reads are cheaper than a sixth constructor dependency, and a third
   * occurrence should move this onto `DictionariesService` rather than be a third copy.
   */
  private async justificationCodeOf(
    itemId: string | undefined,
  ): Promise<string | null> {
    if (!itemId) {
      return null;
    }

    const row = await this.db
      .selectFrom('dictionary_items')
      .select('code')
      .where('id', '=', itemId)
      .where('type_code', '=', 'restriction_justification')
      .executeTakeFirst();

    return row?.code ?? null;
  }

  /**
   * Is this candidate reachable by an employer at all?
   *
   * BR-02's gate again, applied to a write: saving, noting or shortlisting somebody the
   * employer could not have found in search would be a way around it. 404 rather than
   * 403, because "there is a profile here but you may not see it" is more than we owe.
   */
  private async assertFindable(candidateUserId: string): Promise<void> {
    const row = await this.db
      .selectFrom('candidate_profiles')
      .select('user_id')
      .where('user_id', '=', candidateUserId)
      .where('visibility', '=', 'searchable')
      .where('is_complete', '=', true)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('candidate.profile_not_found');
    }
  }

  private async assertOwnsVacancy(
    employerUserId: string,
    vacancyId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom('vacancies')
      .select('id')
      .where('id', '=', vacancyId)
      .where('employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('vacancy.not_found');
    }
  }

  /**
   * One row to one card.
   *
   * There is no BR-09 decision to apply here, and that is the point: §11.1 forbids
   * contact details on a search card unconditionally, so `cardColumns` never selects
   * them and `CandidateCard` has no field to put one in. A serializer that fetched a
   * phone number and then nulled it would be one edit away from leaking it;
   * `candidate-search.query.spec.ts` asserts mechanically that the query touches neither
   * `users` nor `phone`.
   */
  private toCard(row: CardRow, groups: ScoreGroup[]): CandidateCard {
    return {
      candidateUserId: row.user_id,
      fullName: row.full_name,
      regionId: row.region_id,
      districtId: row.district_id,
      settlement: row.settlement,
      category: row.category,
      primaryOccupationId: row.primary_occupation_id,
      occupationLevelId: row.primary_occupation_level_id,
      currentRoleTitle: row.current_role_title,
      currentOccupationId: row.current_occupation_id,
      experienceYears: Number(row.experience_years),
      skills: row.skills ?? [],
      languages: row.languages ?? [],
      salaryFrom: row.salary_from === null ? null : Number(row.salary_from),
      salaryTo: row.salary_to === null ? null : Number(row.salary_to),
      salaryPeriodId: row.salary_period_id,
      salaryIsNegotiable: row.salary_is_negotiable,
      availableFrom: row.available_from,
      completenessPercent: row.completeness_percent,
      lastMeaningfulUpdateAt: row.last_meaningful_update_at,
      photoPath:
        row.photo_file_id === null
          ? null
          : `/candidate-search/candidates/${row.user_id}/photo`,
      isSaved: row.is_saved,
      note: row.note,
      isShortlisted: row.is_shortlisted,
      applicationStatus: row.application_status,
      invitationStatus: row.invitation_status,
      matchScore: Number(row.match_score),
      matchBreakdown: groups.map((group) => ({
        group: group.code,
        weight: group.weight,
        asked: group.asked,
        matched: Number(row.matched[group.code] ?? 0),
      })),
    };
  }
}
