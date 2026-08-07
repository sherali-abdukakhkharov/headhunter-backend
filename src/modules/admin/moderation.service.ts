import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { ComplaintTarget } from '@infra/db/database.types';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { VerificationService } from '@modules/employers/verification.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import {
  type VacancyAggregate,
  loadVacancy,
} from '@modules/vacancies/vacancy-state';

import { AUDIT_ACTIONS, AuditService } from './audit.service';

export interface VerificationQueueItem {
  employerUserId: string;
  type: string;
  name: string | null;
  legalName: string | null;
  regionId: string | null;
  submittedAt: Date;
  /** Evidence, as paths on this API - never a storage URL (ARCHITECTURE.md §9). */
  files: { id: string; purposeCode: string; fileName: string; path: string }[];
}

export interface ModerationQueueItem {
  vacancyId: string;
  employerUserId: string;
  employerName: string | null;
  title: string | null;
  submittedAt: Date;
  /** BR-12: why this one is here, if it carries a restriction. */
  restriction: {
    ageMin: number | null;
    ageMax: number | null;
    genderId: string | null;
    justificationId: string | null;
    justificationNote: string | null;
  } | null;
}

export interface ComplaintItem {
  id: string;
  targetType: ComplaintTarget;
  targetId: string;
  reporterUserId: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: Date;
}

/**
 * §10.2's verification and moderation queues, and §10.2's complaint review.
 *
 * **The decisions themselves are not implemented here.** M4's `VerificationService.decide`
 * and M5's `VacanciesService.moderate` already hold the transition tables, the mandatory
 * reasons and the BR-08 history rows - they were built with M10 in mind and deliberately
 * left without a route. This service supplies the queue, the actor and the audit row.
 *
 * That ordering decides where the audit row is written, and it is worth stating: for a
 * decision that another module commits, the audit row goes in afterwards, because the BR-08
 * history row inside that module's transaction is the record that cannot be lost. For a
 * complaint review, which nothing else records, the audit row is written in the same
 * transaction as the review.
 */
@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly verification: VerificationService,
    private readonly vacancies: VacanciesService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // --- employer verification (§10.2) ---------------------------------------

  /** Oldest submission first: a queue that is not FIFO is a queue somebody waits in. */
  async verificationQueue(
    limit: number,
    offset: number,
  ): Promise<VerificationQueueItem[]> {
    const rows = await this.db
      .selectFrom('verification_submissions as s')
      .innerJoin('employers as e', 'e.user_id', 's.employer_user_id')
      .leftJoin('companies as c', 'c.employer_user_id', 'e.user_id')
      .select([
        's.id as submission_id',
        's.employer_user_id',
        's.submitted_at',
        'e.type',
        'e.full_name',
        'e.region_id',
        'c.legal_name',
        'c.public_name',
      ])
      .where('s.status', '=', 'under_review')
      .orderBy('s.submitted_at')
      .limit(limit)
      .offset(offset)
      .execute();

    return Promise.all(
      rows.map(async (row) => ({
        employerUserId: row.employer_user_id,
        type: row.type,
        name: row.public_name ?? row.full_name,
        legalName: row.legal_name,
        regionId: row.region_id,
        submittedAt: row.submitted_at,
        files: await this.evidenceOf(row.submission_id, row.employer_user_id),
      })),
    );
  }

  /**
   * §10.2's decision, with M4's rules and M10's audit row.
   *
   * The mandatory reason for anything other than an approval is M4's check, not a second
   * copy of it here - `employer.verification_reason_required`.
   */
  async decideVerification(
    actorUserId: string,
    employerUserId: string,
    decision: 'verified' | 'rejected' | 'changes_required',
    reason: string | null,
  ): Promise<void> {
    await this.verification.decide(
      employerUserId,
      decision,
      { userId: actorUserId, role: 'admin' },
      reason,
    );

    await this.audit.recordAfter({
      actorUserId,
      action: AUDIT_ACTIONS.verificationDecided,
      targetType: 'employer',
      targetId: employerUserId,
      reason,
      details: { decision },
    });
  }

  /**
   * Streams a piece of verification evidence to an administrator (§10.2, §11.1).
   *
   * The fourth entitlement-bearing download route, and the same rule as the other three:
   * the entitlement comes from the thing being reviewed, so the route that serves the bytes
   * is the one that can see it. The file must belong to a submission of that employer -
   * an administrator may read evidence, not any file whose id they can name. Logged,
   * because §11.1 requires access to protected data to be.
   */
  async downloadEvidence(
    actorUserId: string,
    employerUserId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    const row = await this.db
      .selectFrom('verification_submission_files as f')
      .innerJoin('verification_submissions as s', 's.id', 'f.submission_id')
      .select('f.file_id')
      .where('f.file_id', '=', fileId)
      .where('s.employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('file.not_found');
    }

    this.logger.log(
      `Admin ${actorUserId} downloaded verification evidence ${fileId} of employer ${employerUserId}`,
    );

    return this.files.readAsAuthorized(employerUserId, fileId);
  }

  // --- vacancy moderation (§10.2, BR-04, BR-12) ----------------------------

  async moderationQueue(
    limit: number,
    offset: number,
  ): Promise<ModerationQueueItem[]> {
    const rows = await this.db
      .selectFrom('vacancies as v')
      .innerJoin('employers as e', 'e.user_id', 'v.employer_user_id')
      .leftJoin('companies as c', 'c.employer_user_id', 'e.user_id')
      .select([
        'v.id',
        'v.employer_user_id',
        'v.title',
        'v.updated_at',
        'v.age_min',
        'v.age_max',
        'v.gender_id',
        'v.restriction_justification_id',
        'v.restriction_justification_note',
        'e.full_name',
        'c.public_name',
      ])
      .where('v.status', '=', 'under_moderation')
      .orderBy('v.updated_at')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      vacancyId: row.id,
      employerUserId: row.employer_user_id,
      employerName: row.public_name ?? row.full_name,
      title: row.title,
      submittedAt: row.updated_at,
      // §10.2 requires the restriction to be reviewed, so the queue shows which items
      // carry one rather than making an administrator open each to find out.
      restriction:
        row.age_min === null && row.age_max === null && row.gender_id === null
          ? null
          : {
              ageMin: row.age_min,
              ageMax: row.age_max,
              genderId: row.gender_id,
              justificationId: row.restriction_justification_id,
              justificationNote: row.restriction_justification_note,
            },
    }));
  }

  /** §10.2's "review vacancy details, requirements ... and restrictions". */
  async vacancyForReview(vacancyId: string): Promise<VacancyAggregate> {
    const aggregate = await loadVacancy(this.db, vacancyId);

    if (!aggregate) {
      throw new NotFoundError('vacancy.not_found');
    }

    return aggregate;
  }

  /** §10.2's approve or reject, with M5's rules and M10's audit row (BR-04, BR-12). */
  async moderateVacancy(
    actorUserId: string,
    vacancyId: string,
    decision: 'active' | 'rejected',
    reason: string | null,
  ): Promise<void> {
    await this.vacancies.moderate(
      vacancyId,
      decision,
      { userId: actorUserId, role: 'admin' },
      reason,
    );

    await this.audit.recordAfter({
      actorUserId,
      action: AUDIT_ACTIONS.vacancyModerated,
      targetType: 'vacancy',
      targetId: vacancyId,
      reason,
      details: { decision },
    });
  }

  /** §10.2's "pause, or remove a vacancy with an audit record". */
  async administrateVacancy(
    actorUserId: string,
    vacancyId: string,
    to: 'paused' | 'closed',
    reason: string,
  ): Promise<void> {
    if (!reason.trim()) {
      throw new ForbiddenError('admin.reason_required');
    }

    await this.vacancies.administrate(
      vacancyId,
      to,
      { userId: actorUserId, role: 'admin' },
      reason,
    );

    await this.audit.recordAfter({
      actorUserId,
      action: AUDIT_ACTIONS.vacancyModerated,
      targetType: 'vacancy',
      targetId: vacancyId,
      reason,
      details: { decision: to, byAdministrator: true },
    });
  }

  // --- complaints (§10.2) --------------------------------------------------

  /** Oldest open complaint first, optionally one target kind at a time. */
  async complaintQueue(
    targetType: ComplaintTarget | undefined,
    limit: number,
    offset: number,
  ): Promise<ComplaintItem[]> {
    let query = this.db
      .selectFrom('complaints')
      .selectAll()
      .where('status', '=', 'open');

    if (targetType) {
      query = query.where('target_type', '=', targetType);
    }

    const rows = await query
      .orderBy('created_at')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map(toComplaint);
  }

  /**
   * One complaint, with enough of its target to judge it (§10.2).
   *
   * The target is resolved per kind rather than joined, because the four kinds live in
   * four tables and a moderator needs a different sentence from each: the message that was
   * reported, the vacancy's title, the person's name. Deliberately small - this is a
   * review screen, not a second copy of the resource, and the full record is one link away.
   */
  async complaint(complaintId: string): Promise<{
    complaint: ComplaintItem;
    target: Record<string, unknown> | null;
  }> {
    const row = await this.db
      .selectFrom('complaints')
      .selectAll()
      .where('id', '=', complaintId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('complaint.not_found');
    }

    return {
      complaint: toComplaint(row),
      target: await this.resolveTarget(row.target_type, row.target_id),
    };
  }

  /**
   * §10.2's decision on a complaint.
   *
   * The audit row is written **in the same transaction**: nothing else records a complaint
   * review, so unlike a verification decision there is no BR-08 row standing behind it.
   */
  async reviewComplaint(
    actorUserId: string,
    complaintId: string,
    outcome: 'actioned' | 'dismissed',
    resolution: string,
  ): Promise<void> {
    if (!resolution.trim()) {
      throw new ForbiddenError('admin.reason_required');
    }

    const outcomeOf = await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('complaints')
        .set({
          status: outcome,
          resolution,
          reviewed_by_user_id: actorUserId,
          reviewed_at: sql`now()`,
        })
        .where('id', '=', complaintId)
        .where('status', '=', 'open')
        .executeTakeFirst();

      // Nothing updated: either it does not exist or somebody reviewed it first. Both are
      // answered after the commit - a throw here would take the audit row with it.
      if (result.numUpdatedRows === 0n) {
        return { error: 'complaint.not_open' } as const;
      }

      await this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.complaintReviewed,
        targetType: 'complaint',
        targetId: complaintId,
        reason: resolution,
        details: { outcome },
      });

      return { ok: true } as const;
    });

    if ('error' in outcomeOf) {
      throw new ConflictError('complaint.not_open');
    }
  }

  private async resolveTarget(
    targetType: ComplaintTarget,
    targetId: string,
  ): Promise<Record<string, unknown> | null> {
    switch (targetType) {
      case 'vacancy': {
        const row = await this.db
          .selectFrom('vacancies')
          .select(['id', 'title', 'status', 'employer_user_id'])
          .where('id', '=', targetId)
          .executeTakeFirst();

        return row ?? null;
      }
      case 'message': {
        const row = await this.db
          .selectFrom('messages')
          .select([
            'id',
            'body',
            'sender_user_id',
            'conversation_id',
            'created_at',
          ])
          .where('id', '=', targetId)
          .executeTakeFirst();

        return row ?? null;
      }
      default: {
        // `user` and `profile` are the same row from a moderator's point of view: who
        // this is and what state their account is in.
        const row = await this.db
          .selectFrom('users')
          .leftJoin(
            'candidate_profiles',
            'candidate_profiles.user_id',
            'users.id',
          )
          .select([
            'users.id',
            'users.status',
            'users.created_at',
            'candidate_profiles.full_name',
          ])
          .where('users.id', '=', targetId)
          .executeTakeFirst();

        return row ?? null;
      }
    }
  }

  private async evidenceOf(submissionId: string, employerUserId: string) {
    const rows = await this.db
      .selectFrom('verification_submission_files as f')
      .innerJoin('stored_files as sf', 'sf.id', 'f.file_id')
      .innerJoin('dictionary_items as di', 'di.id', 'sf.purpose_id')
      .select(['sf.id', 'sf.file_name', 'di.code'])
      .where('f.submission_id', '=', submissionId)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      purposeCode: row.code,
      fileName: row.file_name,
      path: `/admin/employers/${employerUserId}/evidence/${row.id}`,
    }));
  }
}

function toComplaint(row: {
  id: string;
  target_type: ComplaintTarget;
  target_id: string;
  reporter_user_id: string;
  reason: string;
  status: string;
  resolution: string | null;
  created_at: Date;
}): ComplaintItem {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    reporterUserId: row.reporter_user_id,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
  };
}
