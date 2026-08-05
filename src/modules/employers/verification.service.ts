import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  EmployerType,
  UserRole,
  VerificationStatus,
} from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';

import {
  EMPLOYER_REQUIREMENTS,
  requiredEvidence,
} from './employer-requirements';
import { EmployersService } from './employers.service';

export interface VerificationSubmission {
  id: string;
  status: VerificationStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  reason: string | null;
  fileIds: string[];
}

export interface VerificationState {
  status: VerificationStatus;
  reason: string | null;
  verifiedAt: Date | null;
  /** What the employer must upload, resolved for their type (§6.1). */
  requiredEvidence: { purposeCode: string; required: boolean }[];
  submissions: VerificationSubmission[];
}

/**
 * The employer verification machine (§6.1, BR-08).
 *
 * Transitions are validated in one place, and **every** one writes a history row in
 * the same transaction as the status change - including the automatic approval. A
 * status change without its history row is a bug (BR-08), so the two are written
 * together or not at all.
 *
 * Legal transitions:
 *
 *   not_submitted     → under_review
 *   changes_required  → under_review
 *   rejected          → under_review
 *   under_review      → verified | rejected | changes_required
 *
 * `verified` is terminal here. Revoking it is an administrator action against a
 * *user* (§10.4's warn/restrict/block), not a step in this machine - and treating it
 * as one would let an employer resubmit their way out of a revocation.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private readonly reviewEnabled: boolean;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly employers: EmployersService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.reviewEnabled = config.get('EMPLOYER_VERIFICATION_ENABLED', {
      infer: true,
    });
  }

  async state(userId: string): Promise<VerificationState> {
    const profile = await this.employers.findMine(userId);

    const rows = await this.db
      .selectFrom('verification_submissions')
      .select(['id', 'status', 'submitted_at', 'decided_at', 'reason'])
      .where('employer_user_id', '=', userId)
      .orderBy('submitted_at', 'desc')
      .execute();

    // Skipped entirely when there are no submissions: an `IN ()` with an empty list
    // is not valid SQL, and Kysely would compile one.
    const files =
      rows.length === 0
        ? []
        : await this.db
            .selectFrom('verification_submission_files')
            .select(['submission_id', 'file_id'])
            .where(
              'submission_id',
              'in',
              rows.map((row) => row.id),
            )
            .execute();

    return {
      status: profile.verificationStatus,
      reason: profile.verificationReason,
      verifiedAt: profile.verifiedAt,
      requiredEvidence: EMPLOYER_REQUIREMENTS[profile.type].evidence.map(
        (item) => ({ purposeCode: item.purposeCode, required: item.required }),
      ),
      submissions: rows.map((row) => ({
        id: row.id,
        status: row.status,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        reason: row.reason,
        fileIds: files
          .filter((file) => file.submission_id === row.id)
          .map((file) => file.file_id),
      })),
    };
  }

  /**
   * Submits the profile for verification.
   *
   * Validation happens before the transaction opens: the profile must be complete
   * (BR-03's own precondition applies to being reviewable at all), the status must
   * allow a submission, and every required document must be present and owned by
   * this employer. By the time the transaction starts there is nothing left that can
   * fail, which is the rule MEMORY.md records - a throw after a write inside a
   * transaction destroys the write and leaves only the exception.
   */
  async submit(userId: string, fileIds: string[]): Promise<VerificationState> {
    const profile = await this.employers.findMine(userId);

    if (!profile.isComplete) {
      throw new ForbiddenError('employer.profile_incomplete');
    }

    if (!canSubmitFrom(profile.verificationStatus)) {
      throw new ConflictError('employer.verification_not_submittable');
    }

    const files = await this.ownedFiles(userId, fileIds);
    const missing = requiredEvidence(profile.type).filter(
      (purposeCode) => !files.some((file) => file.purposeCode === purposeCode),
    );

    if (missing.length > 0) {
      throw new ForbiddenError('employer.verification_evidence_missing');
    }

    // With no admin module there is nobody who can approve a submission, so the
    // flag decides whether this lands in a queue or is auto-approved. See
    // EMPLOYER_VERIFICATION_ENABLED - without this the employer half of the product
    // would be permanently unreachable behind BR-03.
    const decided: VerificationStatus = this.reviewEnabled
      ? 'under_review'
      : 'verified';

    if (!this.reviewEnabled) {
      this.logger.warn(
        `Employer ${userId} auto-verified: EMPLOYER_VERIFICATION_ENABLED is off, ` +
          'so no human review took place.',
      );
    }

    await this.db.transaction().execute(async (trx) => {
      const submission = await trx
        .insertInto('verification_submissions')
        .values({
          employer_user_id: userId,
          status: decided,
          ...(decided === 'verified'
            ? {
                decided_at: sql`now()`,
                reason: AUTO_VERIFIED_REASON,
              }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (fileIds.length > 0) {
        await trx
          .insertInto('verification_submission_files')
          .values(
            fileIds.map((fileId) => ({
              submission_id: submission.id,
              file_id: fileId,
            })),
          )
          .execute();
      }

      await this.applyStatus(trx, userId, profile.verificationStatus, decided, {
        reason: decided === 'verified' ? AUTO_VERIFIED_REASON : null,
      });
    });

    return this.state(userId);
  }

  /**
   * Records an administrator's decision (§6.1, §10.2).
   *
   * Here rather than in the admin module because the transition rules and the audit
   * row belong to this machine; M10 adds the queue and the route that calls this,
   * not a second copy of the rules.
   *
   * A reason is mandatory for anything other than an approval: §6.1 requires the
   * administrator to say what needs correcting, and a refusal with no reason is one
   * the employer cannot act on.
   */
  async decide(
    employerUserId: string,
    decision: 'verified' | 'rejected' | 'changes_required',
    actor: { userId: string; role: UserRole },
    reason: string | null,
  ): Promise<VerificationState> {
    const profile = await this.employers.find(employerUserId);

    if (!profile) {
      throw new NotFoundError('employer.profile_not_found');
    }

    if (profile.verificationStatus !== 'under_review') {
      throw new ConflictError('employer.verification_not_pending');
    }

    if (decision !== 'verified' && !reason?.trim()) {
      throw new ForbiddenError('employer.verification_reason_required');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('verification_submissions')
        .set({
          status: decision,
          decided_at: sql`now()`,
          decided_by_user_id: actor.userId,
          reason,
        })
        .where('employer_user_id', '=', employerUserId)
        .where('status', '=', 'under_review')
        .execute();

      await this.applyStatus(
        trx,
        employerUserId,
        profile.verificationStatus,
        decision,
        { reason, actor },
      );
    });

    return this.state(employerUserId);
  }

  /**
   * The one place `employers.verification_status` changes, always with its BR-08 row.
   *
   * Private and transaction-scoped on purpose: a caller that could set the status
   * without writing history would be able to produce exactly the state BR-08 exists
   * to prevent.
   */
  private async applyStatus(
    trx: Database,
    userId: string,
    from: VerificationStatus,
    to: VerificationStatus,
    options: {
      reason?: string | null;
      actor?: { userId: string; role: UserRole };
    },
  ): Promise<void> {
    await trx
      .updateTable('employers')
      .set({
        verification_status: to,
        verification_reason: options.reason ?? null,
        // The CHECK constraint requires these to agree, which is what stops a
        // rejection leaving a stale verification timestamp behind.
        verified_at: to === 'verified' ? sql`now()` : null,
        updated_at: sql`now()`,
      })
      .where('user_id', '=', userId)
      .execute();

    await trx
      .insertInto('employer_verification_history')
      .values({
        employer_user_id: userId,
        from_status: from,
        to_status: to,
        actor_user_id: options.actor?.userId ?? null,
        actor_role: options.actor?.role ?? null,
        reason: options.reason ?? null,
      })
      .execute();
  }

  /**
   * The submitted files, with their purpose codes - and only the caller's own.
   *
   * Ownership is checked here rather than trusted: without it an employer could
   * attach another account's file id to their submission and have an administrator
   * review somebody else's document.
   */
  private async ownedFiles(
    userId: string,
    fileIds: string[],
  ): Promise<{ id: string; purposeCode: string }[]> {
    if (fileIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('stored_files')
      .innerJoin(
        'dictionary_items',
        'dictionary_items.id',
        'stored_files.purpose_id',
      )
      .select(['stored_files.id', 'dictionary_items.code'])
      .where('stored_files.id', 'in', fileIds)
      .where('stored_files.owner_user_id', '=', userId)
      .where('stored_files.deleted_at', 'is', null)
      .execute();

    if (rows.length !== fileIds.length) {
      throw new NotFoundError('file.not_found');
    }

    return rows.map((row) => ({ id: row.id, purposeCode: row.code }));
  }
}

/** Recorded as the reason on an automatic approval, so the audit row is honest. */
export const AUTO_VERIFIED_REASON = 'auto_verified_no_reviewer';

export function canSubmitFrom(status: VerificationStatus): boolean {
  return (
    status === 'not_submitted' ||
    status === 'changes_required' ||
    status === 'rejected'
  );
}

/** Exported for the schema-consistency test. */
export type { EmployerType };
