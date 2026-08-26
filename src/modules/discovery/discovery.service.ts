import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type RawBuilder, sql } from 'kysely';

import {
  ConflictError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { DictionaryCategory } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatDateOnly, startOfDayInZone } from '@infra/time/format';

/** §5.5's filter set, all optional. */
export interface DiscoveryFilters {
  occupationIds?: string[];
  regionId?: string;
  districtId?: string;
  employmentTypeIds?: string[];
  workFormatIds?: string[];
  shiftIds?: string[];
  salaryFrom?: number;
  /** The upper half of §5.5's range. See `where` for why it is not a mirror. */
  salaryTo?: number;
  /** §5.5's "experience": a ceiling on what the vacancy *demands*, not a floor. */
  experienceYearsMax?: number;
  /** `language` ids the vacancy must require, any one of them, at any level. */
  languageIds?: string[];
  category?: DictionaryCategory;
  /** Vacancies published on or after this date (§5.5 "publication date"). */
  publishedFrom?: string;
  limit: number;
  offset: number;
}

export interface FeedItem {
  id: string;
  title: string | null;
  category: DictionaryCategory | null;
  occupationId: string | null;
  regionId: string | null;
  districtId: string | null;
  workerCount: number | null;
  salaryFrom: number | null;
  salaryTo: number | null;
  salaryPeriodId: string | null;
  salaryIsNegotiable: boolean;
  deadlineOn: string | null;
  publishedAt: Date | null;
  employer: {
    /** §5.6 shows the employer and their verification status on the vacancy. */
    name: string | null;
    isVerified: boolean;
  };
  isSaved: boolean;
  /** The candidate's own application to this vacancy, if any (§5.6). */
  applicationStatus: string | null;
}

export interface VacancyDetail {
  item: FeedItem;
  description: string | null;
  address: string | null;
  startsOn: string | null;
  endsOn: string | null;
  requirements: {
    fieldCode: string;
    itemId: string | null;
    levelId: string | null;
    isMandatory: boolean;
    valueBool: boolean | null;
    valueInt: number | null;
    valueText: string | null;
  }[];
}

/** One row of a feed query, in database naming. */
interface FeedRow {
  id: string;
  title: string | null;
  category: DictionaryCategory | null;
  occupation_id: string | null;
  region_id: string | null;
  district_id: string | null;
  worker_count: number | null;
  salary_from: string | null;
  salary_to: string | null;
  salary_period_id: string | null;
  salary_is_negotiable: boolean;
  deadline_on: string | null;
  published_at: Date | null;
  verification_status: string;
  employer_name: string | null;
  is_saved: boolean;
  application_status: string | null;
}

interface DetailRow extends FeedRow {
  description: string | null;
  address: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

/**
 * Candidate-facing vacancy discovery (§5.5, §5.6).
 *
 * A separate module from `vacancies` on purpose (ARCHITECTURE.md §2): the employer's view
 * and the candidate's differ in authorization, in filters and in ranking, and merging
 * them produces a permission-shaped mess. The concrete consequence here is that **every
 * query starts from the same `visible` fragment** - active, deadline not passed - so
 * BR-04, BR-06 and BR-11 cannot be forgotten by one code path.
 *
 * Written as SQL fragments rather than through the query builder, for the reason
 * CLAUDE.md gives: Kysely is a query builder and these are SQL-shaped queries. The card
 * needs a scoring expression, two correlated subqueries and three optional semi-joins;
 * expressing that through a builder meant a helper typed `any`, which is worse than SQL
 * that says what it does. The row type is still checked - `sql<FeedRow>` -  so a renamed
 * column fails the build.
 */
@Injectable()
export class DiscoveryService {
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * §5.5's "recommended": rule-based matching on the candidate's own profile.
   *
   * Deliberately **not** a ranking model (ARCHITECTURE.md §12 defers that): occupation
   * counts double, region and category count one each, and ties break on recency. Rule-
   * based means the result is explainable and the first version is debuggable.
   *
   * A candidate with no profile gets the recent feed rather than an empty one - a blank
   * home screen is the worst possible answer to "what work is there".
   */
  async recommended(
    candidateUserId: string,
    filters: DiscoveryFilters,
  ): Promise<FeedItem[]> {
    const profile = await this.db
      .selectFrom('candidate_profiles')
      .select(['region_id', 'category'])
      .where('user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!profile) {
      return this.recent(candidateUserId, filters);
    }

    const occupations = await this.db
      .selectFrom('candidate_occupations')
      .select('item_id')
      .where('user_id', '=', candidateUserId)
      .execute();

    const occupationIds = occupations.map((row) => row.item_id);

    const result = await sql<FeedRow>`
      SELECT ${this.feedColumns(candidateUserId)},
        (
          (CASE WHEN v.occupation_id = ANY(${occupationIds}::uuid[]) THEN 2 ELSE 0 END)
          + (CASE WHEN v.region_id = ${profile.region_id}::uuid THEN 1 ELSE 0 END)
          + (CASE WHEN v.category = ${profile.category}::dictionary_category THEN 1 ELSE 0 END)
        ) AS match_score
      ${this.feedFrom()}
      WHERE ${this.where(filters)}
      ORDER BY match_score DESC, v.published_at DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `.execute(this.db);

    return result.rows.map(toFeedItem);
  }

  /** §5.5's "recently published". */
  async recent(
    candidateUserId: string,
    filters: DiscoveryFilters,
  ): Promise<FeedItem[]> {
    const result = await sql<FeedRow>`
      SELECT ${this.feedColumns(candidateUserId)}
      ${this.feedFrom()}
      WHERE ${this.where(filters)}
      ORDER BY v.published_at DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `.execute(this.db);

    return result.rows.map(toFeedItem);
  }

  /**
   * §5.5's "saved".
   *
   * Saved vacancies are **not** filtered by the visibility fragment: a candidate who
   * saved something needs to see that it closed, not have it silently vanish. BR-11
   * removes a closed vacancy from *discovery*, and a personal list is not discovery.
   */
  async saved(
    candidateUserId: string,
    filters: DiscoveryFilters,
  ): Promise<FeedItem[]> {
    const result = await sql<FeedRow>`
      SELECT ${this.feedColumns(candidateUserId)}
      ${this.feedFrom()}
      JOIN saved_vacancies sv
        ON sv.vacancy_id = v.id AND sv.candidate_user_id = ${candidateUserId}
      ORDER BY sv.created_at DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `.execute(this.db);

    return result.rows.map(toFeedItem);
  }

  /** §5.6's vacancy detail. Visible only while the vacancy is (BR-04, BR-06, BR-11). */
  async detail(
    candidateUserId: string,
    vacancyId: string,
  ): Promise<VacancyDetail> {
    const result = await sql<DetailRow>`
      SELECT ${this.feedColumns(candidateUserId)},
        v.description, v.address, v.starts_on, v.ends_on
      ${this.feedFrom()}
      WHERE v.id = ${vacancyId} AND ${this.visible()}
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundError('vacancy.not_found');
    }

    const requirements = await this.db
      .selectFrom('vacancy_requirements')
      .select([
        'field_code',
        'item_id',
        'level_id',
        'is_mandatory',
        'value_bool',
        'value_int',
        'value_text',
      ])
      .where('vacancy_id', '=', vacancyId)
      .execute();

    return {
      item: toFeedItem(row),
      description: row.description,
      address: row.address,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      requirements: requirements.map((requirement) => ({
        fieldCode: requirement.field_code,
        itemId: requirement.item_id,
        levelId: requirement.level_id,
        isMandatory: requirement.is_mandatory,
        valueBool: requirement.value_bool,
        valueInt: requirement.value_int,
        valueText: requirement.value_text,
      })),
    };
  }

  /** §5.6's Save. Idempotent by primary key - saving twice is saving once. */
  async save(candidateUserId: string, vacancyId: string): Promise<void> {
    await this.assertVacancyExists(vacancyId);

    await this.db
      .insertInto('saved_vacancies')
      .values({ candidate_user_id: candidateUserId, vacancy_id: vacancyId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unsave(candidateUserId: string, vacancyId: string): Promise<void> {
    await this.db
      .deleteFrom('saved_vacancies')
      .where('candidate_user_id', '=', candidateUserId)
      .where('vacancy_id', '=', vacancyId)
      .execute();
  }

  /**
   * §5.6's Report, stored as a complaint for M10's review queue.
   *
   * One open complaint per reporter per target - a partial unique index backs this up, and
   * the check exists to answer with a message rather than a constraint error.
   */
  async report(
    reporterUserId: string,
    vacancyId: string,
    reason: string,
  ): Promise<string> {
    await this.assertVacancyExists(vacancyId);

    const existing = await this.db
      .selectFrom('complaints')
      .select('id')
      .where('target_type', '=', 'vacancy')
      .where('target_id', '=', vacancyId)
      .where('reporter_user_id', '=', reporterUserId)
      .where('status', '=', 'open')
      .executeTakeFirst();

    if (existing) {
      throw new ConflictError('complaint.already_reported');
    }

    const row = await this.db
      .insertInto('complaints')
      .values({
        target_type: 'vacancy',
        target_id: vacancyId,
        reporter_user_id: reporterUserId,
        reason,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * The card's columns (§5.6), plus the candidate's own relationship to each vacancy.
   *
   * The two correlated subqueries let the client render Apply-or-status and the save
   * toggle from one response instead of three.
   */
  private feedColumns(candidateUserId: string): RawBuilder<unknown> {
    return sql`
      v.id, v.title, v.category, v.occupation_id, v.region_id, v.district_id,
      v.worker_count, v.salary_from, v.salary_to, v.salary_period_id,
      v.salary_is_negotiable, v.deadline_on, v.published_at,
      e.verification_status,
      -- A company shows its public name, an individual their own. Never the legal
      -- name: §6.1 keeps both because they differ, and the public one is meant for a
      -- vacancy card.
      COALESCE(c.public_name, e.full_name) AS employer_name,
      EXISTS (
        SELECT 1 FROM saved_vacancies s
        WHERE s.vacancy_id = v.id AND s.candidate_user_id = ${candidateUserId}
      ) AS is_saved,
      (
        SELECT a.status FROM applications a
        WHERE a.vacancy_id = v.id AND a.candidate_user_id = ${candidateUserId}
        ORDER BY a.created_at DESC LIMIT 1
      ) AS application_status
    `;
  }

  private feedFrom(): RawBuilder<unknown> {
    return sql`
      FROM vacancies v
      JOIN employers e ON e.user_id = v.employer_user_id
      LEFT JOIN companies c ON c.employer_user_id = e.user_id
    `;
  }

  /**
   * The predicate every discovery read starts from.
   *
   * BR-04 (not visible until approved), BR-11 (closed leaves discovery) and BR-06's
   * deadline, in one fragment. A feed that showed a vacancy the apply route refuses would
   * look like a bug in Apply, which is why this is not restated per query.
   */
  private visible(): RawBuilder<unknown> {
    const today = formatDateOnly(new Date(), this.timeZone);

    return sql`
      v.status = 'active'
      AND (v.deadline_on IS NULL OR v.deadline_on >= ${today}::date)
    `;
  }

  private where(filters: DiscoveryFilters): RawBuilder<unknown> {
    const conditions: RawBuilder<unknown>[] = [this.visible()];

    if (filters.occupationIds?.length) {
      conditions.push(
        sql`v.occupation_id = ANY(${filters.occupationIds}::uuid[])`,
      );
    }

    if (filters.category) {
      conditions.push(
        sql`v.category = ${filters.category}::dictionary_category`,
      );
    }

    if (filters.regionId) {
      conditions.push(sql`v.region_id = ${filters.regionId}::uuid`);
    }

    if (filters.districtId) {
      conditions.push(sql`v.district_id = ${filters.districtId}::uuid`);
    }

    if (filters.publishedFrom) {
      // An instant in the platform zone, not a SQL date cast: the cast resolves in the
      // session zone (UTC here), which would hide a vacancy published at 02:00 Tashkent
      // on the very day being asked for.
      const start = startOfDayInZone(filters.publishedFrom, this.timeZone);
      conditions.push(sql`v.published_at >= ${start}`);
    }

    if (filters.salaryFrom !== undefined) {
      // A negotiable vacancy passes a salary floor: it has not said no to the figure,
      // and excluding it would hide much of the seasonal work this product exists for.
      conditions.push(sql`(
        v.salary_is_negotiable
        OR v.salary_to >= ${filters.salaryFrom}
        OR v.salary_from >= ${filters.salaryFrom}
      )`);
    }

    if (filters.salaryTo !== undefined) {
      // Deliberately not a mirror image of the floor. A vacancy is out only when its
      // *floor* is above the ceiling asked for, so any overlapping range is in - and a
      // vacancy stating only "up to 3,000,000" has no floor, which must pass a ceiling
      // of 2,000,000 rather than fail a NULL comparison.
      conditions.push(sql`(
        v.salary_is_negotiable
        OR v.salary_from IS NULL
        OR v.salary_from <= ${filters.salaryTo}
      )`);
    }

    if (filters.experienceYearsMax !== undefined) {
      // NOT EXISTS, not EXISTS, and that is the whole of this filter. Experience on a
      // vacancy is a *demand* rather than an attribute, so §5.5's "experience" asks to
      // hide what the candidate cannot reach - which makes a vacancy that states no
      // requirement a pass, since it demands nothing. The employer's filter over
      // `candidate_experience` is the same word with the opposite polarity.
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM vacancy_requirements r
        WHERE r.vacancy_id = v.id
          AND r.field_code = 'experience_years_min'
          AND r.value_int > ${filters.experienceYearsMax}
      )`);
    }

    // Requirement-backed filters: one semi-join per field over a single indexed table,
    // matching any of the ids the candidate chose.
    for (const [fieldCode, ids] of [
      ['employment_type_ids', filters.employmentTypeIds],
      ['work_format_ids', filters.workFormatIds],
      ['shift_ids', filters.shiftIds],
      // Level is not compared. §5.5 asks for "language", and a vacancy wanting Russian
      // at C1 is still a Russian vacancy to somebody filtering for Russian work.
      ['languages', filters.languageIds],
    ] as const) {
      if (ids?.length) {
        conditions.push(sql`EXISTS (
          SELECT 1 FROM vacancy_requirements r
          WHERE r.vacancy_id = v.id
            AND r.field_code = ${fieldCode}
            AND r.item_id = ANY(${ids}::uuid[])
        )`);
      }
    }

    return sql.join(conditions, sql` AND `);
  }

  private async assertVacancyExists(vacancyId: string): Promise<void> {
    const row = await this.db
      .selectFrom('vacancies')
      .select('id')
      .where('id', '=', vacancyId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('vacancy.not_found');
    }
  }
}

function toFeedItem(row: FeedRow): FeedItem {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    occupationId: row.occupation_id,
    regionId: row.region_id,
    districtId: row.district_id,
    workerCount: row.worker_count,
    salaryFrom: row.salary_from === null ? null : Number(row.salary_from),
    salaryTo: row.salary_to === null ? null : Number(row.salary_to),
    salaryPeriodId: row.salary_period_id,
    salaryIsNegotiable: row.salary_is_negotiable,
    deadlineOn: row.deadline_on,
    publishedAt: row.published_at,
    employer: {
      name: row.employer_name,
      isVerified: row.verification_status === 'verified',
    },
    isSaved: row.is_saved,
    applicationStatus: row.application_status,
  };
}
