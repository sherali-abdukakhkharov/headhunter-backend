import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { ApplicationStatus, UserRole } from '@infra/db/database.types';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { formatDateOnly } from '@infra/time/format';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '@infra/env-schema';
import { isOpenForApplications } from '@modules/vacancies/vacancy-status';

import { actorFor, canTransition, isTerminal } from './application-status';

export interface Application {
  id: string;
  vacancyId: string;
  candidateUserId: string;
  status: ApplicationStatus;
  coverNote: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationCounts {
  workerCount: number | null;
  hiredCount: number;
  byStatus: Record<string, number>;
}

@Injectable()
export class ApplicationsService {
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly idempotency: IdempotencyService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * Applies to a vacancy (§5.6, BR-02, BR-06, BR-07, BR-08).
   *
   * Everything that can refuse the request happens **inside one transaction**, because
   * two of the three rules are races:
   *
   * - **BR-06** reads the vacancy `FOR SHARE`, so the deadline and status cannot change
   *   between the check and the insert - and the share lock blocks a concurrent close
   *   rather than being blocked by an unrelated read.
   * - **BR-07** is the partial unique index. The insert is what enforces it; the
   *   friendly check beforehand exists only to produce a better message in the common
   *   case, and a concurrent double-tap that gets past it is caught by the constraint.
   * - **BR-08** writes the `submitted` history row in the same transaction as the
   *   application, so an application without its history cannot exist.
   *
   * Nothing throws *after* a write in the transaction: the outcome is returned and the
   * error raised after the commit. That is the M1 trap in MEMORY.md - a throw inside
   * rolls back the very row that was meant to record what happened.
   */
  async apply(
    candidateUserId: string,
    vacancyId: string,
    coverNote: string | null,
    idempotencyKey?: string,
  ): Promise<Application> {
    const id = await this.idempotency.run(
      idempotencyKey,
      candidateUserId,
      'application.apply',
      { vacancyId, coverNote },
      () => this.insertApplication(candidateUserId, vacancyId, coverNote),
    );

    return this.byId(id);
  }

  private async insertApplication(
    candidateUserId: string,
    vacancyId: string,
    coverNote: string | null,
  ): Promise<string> {
    const today = formatDateOnly(new Date(), this.timeZone);

    const outcome = await this.db.transaction().execute(async (trx) => {
      // BR-02: a candidate applies with a profile, and the foreign key requires one to
      // exist. Checked here so the answer is a message rather than a constraint error.
      const profile = await trx
        .selectFrom('candidate_profiles')
        .select('user_id')
        .where('user_id', '=', candidateUserId)
        .executeTakeFirst();

      if (!profile) {
        return { error: 'candidate.profile_required' } as const;
      }

      // FOR SHARE, not FOR UPDATE: this reader must not block other applicants, but it
      // must stop the employer closing the vacancy underneath it.
      const vacancy = await trx
        .selectFrom('vacancies')
        .select(['id', 'status', 'deadline_on'])
        .where('id', '=', vacancyId)
        .forShare()
        .executeTakeFirst();

      if (!vacancy) {
        return { error: 'vacancy.not_found' } as const;
      }

      // BR-06, and BR-04's visibility rule in the same call: a vacancy that is not
      // active is not applicable, whether because it never published, is paused, or is
      // closed (BR-11).
      if (!isOpenForApplications(vacancy.status, vacancy.deadline_on, today)) {
        return { error: 'application.vacancy_closed' } as const;
      }

      const active = await trx
        .selectFrom('applications')
        .select(['id', 'status'])
        .where('vacancy_id', '=', vacancyId)
        .where('candidate_user_id', '=', candidateUserId)
        .where('status', 'not in', ['withdrawn', 'rejected'])
        .executeTakeFirst();

      if (active) {
        return { error: 'application.already_applied' } as const;
      }

      const created = await trx
        .insertInto('applications')
        .values({
          vacancy_id: vacancyId,
          candidate_user_id: candidateUserId,
          status: 'submitted',
          cover_note: coverNote,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('application_stage_history')
        .values({
          application_id: created.id,
          from_status: null,
          to_status: 'submitted',
          actor_user_id: candidateUserId,
          actor_role: 'candidate',
        })
        .execute();

      return { id: created.id } as const;
    });

    if ('error' in outcome) {
      switch (outcome.error) {
        case 'vacancy.not_found':
          throw new NotFoundError('vacancy.not_found');
        case 'candidate.profile_required':
          throw new ForbiddenError('candidate.profile_required');
        case 'application.vacancy_closed':
          throw new ConflictError('application.vacancy_closed');
        default:
          throw new ConflictError('application.already_applied');
      }
    }

    return outcome.id;
  }

  /** §5.6: withdrawal, up to an accepted offer - which `hired` being terminal expresses. */
  async withdraw(
    candidateUserId: string,
    applicationId: string,
  ): Promise<Application> {
    const application = await this.byId(applicationId);

    if (application.candidateUserId !== candidateUserId) {
      throw new NotFoundError('application.not_found');
    }

    return this.move(applicationId, 'withdrawn', {
      userId: candidateUserId,
      role: 'candidate',
    });
  }

  /**
   * An employer stage move (§8.1, §6.5).
   *
   * The employer must own the vacancy, which is checked before anything else: an
   * employer moving another employer's applicant would be both a data and a privacy
   * breach.
   */
  async moveStage(
    employerUserId: string,
    applicationId: string,
    to: ApplicationStatus,
    reason: string | null,
  ): Promise<Application> {
    await this.assertEmployerOwns(employerUserId, applicationId);

    return this.move(
      applicationId,
      to,
      { userId: employerUserId, role: 'employer' },
      reason,
    );
  }

  /**
   * The one place a status changes, always with its BR-08 history row - and, for a hire,
   * the vacancy's counter in the same transaction (§6.5).
   */
  private async move(
    applicationId: string,
    to: ApplicationStatus,
    actor: { userId: string; role: UserRole },
    reason: string | null = null,
  ): Promise<Application> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('applications')
        .select(['id', 'status', 'vacancy_id'])
        .where('id', '=', applicationId)
        .forUpdate()
        .executeTakeFirst();

      if (!current) {
        return { error: 'application.not_found' } as const;
      }

      if (isTerminal(current.status)) {
        return { error: 'application.final' } as const;
      }

      if (!canTransition(current.status, to)) {
        return { error: 'application.transition_not_allowed' } as const;
      }

      // §8.1's second column. The route's role guard already narrows this, but the rule
      // belongs with the machine - a future admin route must not be able to withdraw on
      // a candidate's behalf by accident.
      if (actorFor(to) !== actor.role) {
        return { error: 'application.wrong_actor' } as const;
      }

      await trx
        .updateTable('applications')
        .set({
          status: to,
          rejection_reason: to === 'rejected' ? reason : null,
          updated_at: sql`now()`,
        })
        .where('id', '=', applicationId)
        .execute();

      await trx
        .insertInto('application_stage_history')
        .values({
          application_id: applicationId,
          from_status: current.status,
          to_status: to,
          actor_user_id: actor.userId,
          actor_role: actor.role,
          reason,
        })
        .execute();

      // §6.5 shows hires against the required worker count. Incremented here rather
      // than counted on read so the employer dashboard is one row, and in the same
      // transaction so it cannot disagree with the applications it counts.
      if (to === 'hired') {
        await trx
          .updateTable('vacancies')
          .set({ hired_count: sql`hired_count + 1`, updated_at: sql`now()` })
          .where('id', '=', current.vacancy_id)
          .execute();
      }

      return { ok: true } as const;
    });

    if ('error' in outcome) {
      switch (outcome.error) {
        case 'application.not_found':
          throw new NotFoundError('application.not_found');
        case 'application.final':
          throw new ConflictError('application.final');
        case 'application.wrong_actor':
          throw new ForbiddenError('application.wrong_actor');
        default:
          throw new ConflictError('application.transition_not_allowed');
      }
    }

    return this.byId(applicationId);
  }

  async byId(applicationId: string): Promise<Application> {
    const row = await this.db
      .selectFrom('applications')
      .selectAll()
      .where('id', '=', applicationId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('application.not_found');
    }

    return toApplication(row);
  }

  /** The candidate's own applications, newest first (§5.6 shows their statuses). */
  async listForCandidate(candidateUserId: string): Promise<Application[]> {
    const rows = await this.db
      .selectFrom('applications')
      .selectAll()
      .where('candidate_user_id', '=', candidateUserId)
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map(toApplication);
  }

  /** §6.5: applications for one of the employer's vacancies, optionally by status. */
  async listForVacancy(
    employerUserId: string,
    vacancyId: string,
    status?: ApplicationStatus,
  ): Promise<Application[]> {
    await this.assertEmployerOwnsVacancy(employerUserId, vacancyId);

    let query = this.db
      .selectFrom('applications')
      .selectAll()
      .where('vacancy_id', '=', vacancyId);

    if (status) {
      query = query.where('status', '=', status);
    }

    const rows = await query.orderBy('created_at', 'desc').execute();

    return rows.map(toApplication);
  }

  /** §6.5's counters: hired against required, and a breakdown by stage. */
  async countsForVacancy(
    employerUserId: string,
    vacancyId: string,
  ): Promise<ApplicationCounts> {
    const vacancy = await this.assertEmployerOwnsVacancy(
      employerUserId,
      vacancyId,
    );

    const rows = await this.db
      .selectFrom('applications')
      .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
      .where('vacancy_id', '=', vacancyId)
      .groupBy('status')
      .execute();

    const byStatus: Record<string, number> = {};

    for (const row of rows) {
      byStatus[row.status] = Number(row.count);
    }

    return {
      workerCount: vacancy.worker_count,
      hiredCount: vacancy.hired_count,
      byStatus,
    };
  }

  /** §6.5's internal note: employer-only, and never part of a candidate-facing read. */
  async addNote(
    employerUserId: string,
    applicationId: string,
    note: string,
  ): Promise<{ id: string; note: string; createdAt: Date }> {
    await this.assertEmployerOwns(employerUserId, applicationId);

    const row = await this.db
      .insertInto('application_notes')
      .values({
        application_id: applicationId,
        author_user_id: employerUserId,
        note,
      })
      .returning(['id', 'note', 'created_at'])
      .executeTakeFirstOrThrow();

    return { id: row.id, note: row.note, createdAt: row.created_at };
  }

  async listNotes(
    employerUserId: string,
    applicationId: string,
  ): Promise<{ id: string; note: string; createdAt: Date }[]> {
    await this.assertEmployerOwns(employerUserId, applicationId);

    const rows = await this.db
      .selectFrom('application_notes')
      .select(['id', 'note', 'created_at'])
      .where('application_id', '=', applicationId)
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  /** BR-08's trail, for either side of one application. */
  async history(applicationId: string): Promise<
    {
      fromStatus: ApplicationStatus | null;
      toStatus: ApplicationStatus;
      actorRole: UserRole | null;
      reason: string | null;
      createdAt: Date;
    }[]
  > {
    const rows = await this.db
      .selectFrom('application_stage_history')
      .select([
        'from_status',
        'to_status',
        'actor_role',
        'reason',
        'created_at',
      ])
      .where('application_id', '=', applicationId)
      .orderBy('created_at')
      .execute();

    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorRole: row.actor_role,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  private async assertEmployerOwns(
    employerUserId: string,
    applicationId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom('applications')
      .innerJoin('vacancies', 'vacancies.id', 'applications.vacancy_id')
      .select('applications.id')
      .where('applications.id', '=', applicationId)
      .where('vacancies.employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    // 404 rather than 403: an employer must not learn that an application id exists on
    // somebody else's vacancy (§11.1).
    if (!row) {
      throw new NotFoundError('application.not_found');
    }
  }

  private async assertEmployerOwnsVacancy(
    employerUserId: string,
    vacancyId: string,
  ): Promise<{ worker_count: number | null; hired_count: number }> {
    const row = await this.db
      .selectFrom('vacancies')
      .select(['worker_count', 'hired_count'])
      .where('id', '=', vacancyId)
      .where('employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('vacancy.not_found');
    }

    return row;
  }
}

function toApplication(row: {
  id: string;
  vacancy_id: string;
  candidate_user_id: string;
  status: ApplicationStatus;
  cover_note: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}): Application {
  return {
    id: row.id,
    vacancyId: row.vacancy_id,
    candidateUserId: row.candidate_user_id,
    status: row.status,
    coverNote: row.cover_note,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
