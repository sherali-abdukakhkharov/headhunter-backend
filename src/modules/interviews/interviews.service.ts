import { Inject, Injectable } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';

import {
  ConflictError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DB,
  InterviewStatus,
  InterviewType,
  UserRole,
} from '@infra/db/database.types';
import { ApplicationsService } from '@modules/applications/applications.service';
import { NotificationsService } from '@modules/notifications/notifications.service';

import { canRespond, detailViolation, isTerminal } from './interview-rules';

export interface InterviewInput {
  type: InterviewType;
  scheduledAt: Date;
  location?: string | null;
  meetingLink?: string | null;
  instructions?: string | null;
}

export interface Interview {
  id: string;
  applicationId: string;
  type: InterviewType;
  scheduledAt: Date;
  location: string | null;
  meetingLink: string | null;
  instructions: string | null;
  status: InterviewStatus;
  responseNote: string | null;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InterviewRow {
  id: string;
  application_id: string;
  type: InterviewType;
  scheduled_at: Date;
  location: string | null;
  meeting_link: string | null;
  instructions: string | null;
  status: InterviewStatus;
  response_note: string | null;
  responded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Interview scheduling (§8.3).
 *
 * Three decisions worth stating, because none of them is visible from the table §8.3
 * gives:
 *
 * - **Scheduling moves the application to §8.1's `interview` stage, in the same
 *   transaction.** The stage table says the candidate is told "date, time, type and
 *   location/link" when that stage is set - which *is* the interview. Two separate calls
 *   would let the pair disagree, so `ApplicationsService.ensureInterviewStage` runs inside
 *   the transaction that writes the interview, and BR-08's stage history row is written
 *   with it.
 * - **Rescheduling always resets the candidate's answer.** An interview moved to another
 *   time has not been confirmed, whatever was said about the old one.
 * - **`confirmed` is not terminal.** A candidate who confirms and then finds a clash must
 *   be able to ask for another time; only `cancelled` ends an interview.
 */
@Injectable()
export class InterviewsService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly applications: ApplicationsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** §8.3's scheduling, by the employer who owns the vacancy. */
  async schedule(
    employerUserId: string,
    applicationId: string,
    input: InterviewInput,
  ): Promise<Interview> {
    await this.assertEmployerOwns(employerUserId, applicationId);
    this.assertDetails(input);

    const id = await this.db.transaction().execute(async (trx) => {
      // First, and before any write of this transaction's own: it throws, and a throw
      // after a write would roll back the very row that recorded what happened.
      await this.applications.ensureInterviewStage(
        trx,
        applicationId,
        employerUserId,
      );

      const created = await trx
        .insertInto('interviews')
        .values({
          application_id: applicationId,
          type: input.type,
          scheduled_at: input.scheduledAt,
          location: input.location ?? null,
          meeting_link: input.meetingLink ?? null,
          instructions: input.instructions ?? null,
          status: 'scheduled',
          created_by_user_id: employerUserId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('interview_status_history')
        .values({
          interview_id: created.id,
          from_status: null,
          to_status: 'scheduled',
          actor_user_id: employerUserId,
          actor_role: 'employer',
        })
        .execute();

      return created.id;
    });

    await this.announce(id, 'interview_scheduled');

    return this.byId(id);
  }

  /**
   * §8.3's reschedule: a new time, type or place, set by the employer.
   *
   * The whole interview is replaced rather than patched, for the reason the vacancy's
   * requirement lists are rewritten wholesale: the fields are interdependent - a type
   * change decides which of `location` and `meetingLink` may exist at all - and a partial
   * update would let a phone interview keep the address of the in-person one it used to
   * be.
   */
  async reschedule(
    employerUserId: string,
    interviewId: string,
    input: InterviewInput,
  ): Promise<Interview> {
    const interview = await this.byId(interviewId);
    await this.assertEmployerOwns(employerUserId, interview.applicationId);
    this.assertDetails(input);

    if (isTerminal(interview.status)) {
      throw new ConflictError('interview.final');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('interviews')
        .set({
          type: input.type,
          scheduled_at: input.scheduledAt,
          location: input.location ?? null,
          meeting_link: input.meetingLink ?? null,
          instructions: input.instructions ?? null,
          // A new time is a new question, so the candidate's answer to the old one goes
          // with it - see `statusAfterReschedule`.
          status: 'scheduled',
          response_note: null,
          responded_at: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', interviewId)
        .execute();

      await this.writeHistory(trx, interviewId, interview.status, 'scheduled', {
        userId: employerUserId,
        role: 'employer',
      });
    });

    await this.announce(interviewId, 'interview_changed');

    return this.byId(interviewId);
  }

  /** The employer calling it off. Not in §8.3's list; argued in the migration. */
  async cancel(
    employerUserId: string,
    interviewId: string,
    reason: string | null,
  ): Promise<Interview> {
    const interview = await this.byId(interviewId);
    await this.assertEmployerOwns(employerUserId, interview.applicationId);

    if (isTerminal(interview.status)) {
      throw new ConflictError('interview.final');
    }

    return this.setStatus(
      interviewId,
      interview.status,
      'cancelled',
      { userId: employerUserId, role: 'employer' },
      reason,
    );
  }

  /**
   * §8.3's "Candidate response: confirm or request another time".
   *
   * One method for both, because they differ only in the status: the ownership check, the
   * transition rule and the BR-08 history row are identical, and splitting them is how
   * one of the two ends up without the audit row.
   */
  async respond(
    candidateUserId: string,
    interviewId: string,
    to: InterviewStatus,
    note: string | null,
  ): Promise<Interview> {
    const interview = await this.byId(interviewId);
    await this.assertCandidateOwns(candidateUserId, interview.applicationId);

    if (isTerminal(interview.status)) {
      throw new ConflictError('interview.final');
    }

    if (!canRespond(interview.status, to)) {
      throw new ConflictError('interview.response_not_allowed');
    }

    return this.setStatus(
      interviewId,
      interview.status,
      to,
      { userId: candidateUserId, role: 'candidate' },
      note,
    );
  }

  async byId(interviewId: string): Promise<Interview> {
    const row = await this.db
      .selectFrom('interviews')
      .selectAll()
      .where('id', '=', interviewId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('interview.not_found');
    }

    return toInterview(row);
  }

  /** One application's interviews, for either side of it. */
  async listForApplication(
    userId: string,
    role: UserRole | null,
    applicationId: string,
  ): Promise<Interview[]> {
    if (role === 'candidate') {
      await this.assertCandidateOwns(userId, applicationId);
    } else {
      await this.assertEmployerOwns(userId, applicationId);
    }

    const rows = await this.db
      .selectFrom('interviews')
      .selectAll()
      .where('application_id', '=', applicationId)
      .orderBy('scheduled_at', 'desc')
      .execute();

    return rows.map(toInterview);
  }

  /**
   * The candidate's own interviews across every application.
   *
   * Not in §8.3, which describes one interview - but a candidate with four applications
   * needs one list of where to be and when, and assembling it client-side would be four
   * requests to render one screen.
   */
  async listForCandidate(candidateUserId: string): Promise<Interview[]> {
    const rows = await this.db
      .selectFrom('interviews')
      .innerJoin('applications', 'applications.id', 'interviews.application_id')
      .selectAll('interviews')
      .where('applications.candidate_user_id', '=', candidateUserId)
      .where('interviews.status', '!=', 'cancelled')
      .orderBy('interviews.scheduled_at', 'desc')
      .execute();

    return rows.map(toInterview);
  }

  /**
   * §9.2 row 6: "Interview created or changed → **Both parties**".
   *
   * Both, as written, even though one of them just performed the action: an employer's
   * hiring is rarely one person, and the row says both. The time is formatted by the
   * client from the target rather than interpolated here as a string, which is why the
   * message carries the instant rather than a rendered date.
   */
  private async announce(
    interviewId: string,
    event: 'interview_scheduled' | 'interview_changed',
  ): Promise<void> {
    const row = await this.db
      .selectFrom('interviews')
      .innerJoin('applications', 'applications.id', 'interviews.application_id')
      .innerJoin('vacancies', 'vacancies.id', 'applications.vacancy_id')
      .select([
        'interviews.scheduled_at',
        'applications.candidate_user_id',
        'vacancies.employer_user_id',
      ])
      .where('interviews.id', '=', interviewId)
      .executeTakeFirst();

    if (!row) {
      return;
    }

    const params = { when: row.scheduled_at.toISOString() };

    await this.notifications.notifyAll([
      {
        userId: row.candidate_user_id,
        event,
        params,
        target: { type: 'interview', id: interviewId },
      },
      {
        userId: row.employer_user_id,
        event,
        params,
        target: { type: 'interview', id: interviewId },
      },
    ]);
  }

  /** BR-08's trail for one interview. */
  async history(interviewId: string): Promise<
    {
      fromStatus: InterviewStatus | null;
      toStatus: InterviewStatus;
      actorRole: UserRole | null;
      reason: string | null;
      createdAt: Date;
    }[]
  > {
    const rows = await this.db
      .selectFrom('interview_status_history')
      .select([
        'from_status',
        'to_status',
        'actor_role',
        'reason',
        'created_at',
      ])
      .where('interview_id', '=', interviewId)
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

  /** The one place a status changes, always with its history row (BR-08). */
  private async setStatus(
    interviewId: string,
    from: InterviewStatus,
    to: InterviewStatus,
    actor: { userId: string; role: UserRole },
    reason: string | null,
  ): Promise<Interview> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('interviews')
        .set({
          status: to,
          response_note: actor.role === 'candidate' ? reason : null,
          responded_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', interviewId)
        .execute();

      await this.writeHistory(trx, interviewId, from, to, actor, reason);
    });

    return this.byId(interviewId);
  }

  private async writeHistory(
    trx: Transaction<DB>,
    interviewId: string,
    from: InterviewStatus | null,
    to: InterviewStatus,
    actor: { userId: string; role: UserRole },
    reason: string | null = null,
  ): Promise<void> {
    await trx
      .insertInto('interview_status_history')
      .values({
        interview_id: interviewId,
        from_status: from,
        to_status: to,
        actor_user_id: actor.userId,
        actor_role: actor.role,
        reason,
      })
      .execute();
  }

  /**
   * §8.3's conditional requirement, as a field-level violation.
   *
   * The CHECK constraint refuses the same shapes; this exists so the answer is a message
   * against the field the client can focus, rather than a constraint error - the same
   * split the vacancy submit uses for its missing fields.
   */
  private assertDetails(input: InterviewInput): void {
    const violation = detailViolation(input);

    if (violation) {
      throw new ValidationFailedException([
        {
          field: violation,
          rule: 'requiredByInterviewType',
          messageKey: 'interview.detail_required',
        },
      ]);
    }
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

    // 404 rather than 403 throughout: an employer must not learn that an application
    // exists on somebody else's vacancy (§11.1).
    if (!row) {
      throw new NotFoundError('application.not_found');
    }
  }

  private async assertCandidateOwns(
    candidateUserId: string,
    applicationId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom('applications')
      .select('id')
      .where('id', '=', applicationId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('application.not_found');
    }
  }
}

function toInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    applicationId: row.application_id,
    type: row.type,
    scheduledAt: row.scheduled_at,
    location: row.location,
    meetingLink: row.meeting_link,
    instructions: row.instructions,
    status: row.status,
    responseNote: row.response_note,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
