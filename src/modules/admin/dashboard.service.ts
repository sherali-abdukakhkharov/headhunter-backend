import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';
import { endOfDayInZone, startOfDayInZone } from '@infra/time/format';

export interface DashboardCounters {
  /** The period the "new" and "for the period" counts cover. */
  period: { from: string; to: string };
  candidates: { total: number; new: number };
  employers: { total: number; new: number };
  /** §10.1's queues - what an administrator has to act on. */
  awaitingVerification: number;
  awaitingModeration: number;
  activeVacancies: number;
  applications: number;
  openComplaints: number;
  restrictedUsers: number;
  blockedUsers: number;
}

interface CounterRow {
  candidates_total: string;
  candidates_new: string;
  employers_total: string;
  employers_new: string;
  awaiting_verification: string;
  awaiting_moderation: string;
  active_vacancies: string;
  applications: string;
  open_complaints: string;
  restricted_users: string;
  blocked_users: string;
}

/**
 * §10.1's administrator dashboard.
 *
 * One statement, not eleven. Every number here is a `count` over a different table, and a
 * dashboard that issued a request per tile would be the slowest screen in the product for
 * the person who opens it most often - so they are collected as scalar subqueries in a
 * single round trip.
 *
 * Two of §10.1's lines are read as *period* counts ("newly registered", "active vacancies
 * and applications for the selected period") and the rest as current state. The period is
 * a pair of calendar dates the caller chooses; a queue length is meaningless "for a
 * period", because what matters about it is how long it is right now.
 */
@Injectable()
export class DashboardService {
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  async counters(from: string, to: string): Promise<DashboardCounters> {
    // The end date is inclusive, which is what a person picking "1st to 7th" means, so the
    // comparison is half-open against the *next* day's start - a row created at 23:30 on
    // the 7th is inside the period.
    //
    // Both bounds are resolved to instants **here** rather than cast in SQL. `created_at >=
    // '2026-08-01'::date` resolves that cast in the session zone, which is UTC on this
    // deployment, so it would mean 05:00 Tashkent: every one of these counts would have
    // filed a 02:00 registration under the previous day, and silently, because every
    // machine on this project sits at UTC+5 and the dates still looked plausible.
    const start = startOfDayInZone(from, this.timeZone);
    const end = endOfDayInZone(to, this.timeZone);
    const result = await sql<CounterRow>`
      SELECT
        (SELECT count(*) FROM candidate_profiles) AS candidates_total,
        (
          SELECT count(*) FROM candidate_profiles
          WHERE created_at >= ${start} AND created_at < ${end}
        ) AS candidates_new,
        (SELECT count(*) FROM employers) AS employers_total,
        (
          SELECT count(*) FROM employers
          WHERE created_at >= ${start} AND created_at < ${end}
        ) AS employers_new,
        (
          SELECT count(*) FROM employers WHERE verification_status = 'under_review'
        ) AS awaiting_verification,
        (
          SELECT count(*) FROM vacancies WHERE status = 'under_moderation'
        ) AS awaiting_moderation,
        (
          SELECT count(*) FROM vacancies
          WHERE status = 'active'
            AND published_at >= ${start} AND published_at < ${end}
        ) AS active_vacancies,
        (
          SELECT count(*) FROM applications
          WHERE created_at >= ${start} AND created_at < ${end}
        ) AS applications,
        (SELECT count(*) FROM complaints WHERE status = 'open') AS open_complaints,
        (SELECT count(*) FROM users WHERE status = 'restricted') AS restricted_users,
        (SELECT count(*) FROM users WHERE status = 'blocked') AS blocked_users
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      throw new Error('Dashboard counters returned no row');
    }

    return {
      period: { from, to },
      candidates: {
        total: Number(row.candidates_total),
        new: Number(row.candidates_new),
      },
      employers: {
        total: Number(row.employers_total),
        new: Number(row.employers_new),
      },
      awaitingVerification: Number(row.awaiting_verification),
      awaitingModeration: Number(row.awaiting_moderation),
      activeVacancies: Number(row.active_vacancies),
      applications: Number(row.applications),
      openComplaints: Number(row.open_complaints),
      restrictedUsers: Number(row.restricted_users),
      blockedUsers: Number(row.blocked_users),
    };
  }
}
