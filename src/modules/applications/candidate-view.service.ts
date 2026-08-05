import { Inject, Injectable, Logger } from '@nestjs/common';

import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { type Database, KYSELY } from '@infra/db/database.module';
import {
  type ExposureDecision,
  expose,
  exposedPhone,
} from '@infra/privacy/contact-exposure';
import { EmployersService } from '@modules/employers/employers.service';

import { ApplicationsService } from './applications.service';

export interface CandidateForEmployer {
  candidateUserId: string;
  fullName: string | null;
  regionId: string | null;
  districtId: string | null;
  availableFrom: string | null;
  completenessPercent: number;
  phone: string | null;
  canViewFiles: boolean;
  files: {
    id: string;
    purposeCode: string;
    fileName: string;
    downloadPath: string;
  }[];
  exposureReason: ExposureDecision['reason'];
}

/**
 * What an employer may see of a candidate who applied (§6.5, BR-09, §11.1).
 *
 * §6.5 requires application management to "open the candidate profile and authorized
 * CV". **"Authorized" is BR-09**, and this is the only place in the product that decides
 * it: the rule itself lives in `infra/privacy/contact-exposure.ts` and everything here
 * does is gather its three inputs and apply the answer.
 *
 * Every access is logged, because §11.1 requires it: "access to protected data is
 * logged". The log records the decision's reason code, so an audit can distinguish an
 * employer who was entitled to a phone number from one who asked and was refused.
 */
@Injectable()
export class CandidateViewService {
  private readonly logger = new Logger(CandidateViewService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly employers: EmployersService,
    private readonly applications: ApplicationsService,
    private readonly files: FilesService,
  ) {}

  async forApplication(
    employerUserId: string,
    applicationId: string,
  ): Promise<CandidateForEmployer> {
    const application = await this.db
      .selectFrom('applications')
      .innerJoin('vacancies', 'vacancies.id', 'applications.vacancy_id')
      .select(['applications.candidate_user_id'])
      .where('applications.id', '=', applicationId)
      .where('vacancies.employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    // 404 rather than 403: an employer must not learn that an application exists on
    // another employer's vacancy (§11.1).
    if (!application) {
      throw new NotFoundError('application.not_found');
    }

    return this.read(
      employerUserId,
      application.candidate_user_id,
      applicationId,
    );
  }

  private async read(
    employerUserId: string,
    candidateUserId: string,
    applicationId: string,
  ): Promise<CandidateForEmployer> {
    const profile = await this.db
      .selectFrom('candidate_profiles')
      .innerJoin('users', 'users.id', 'candidate_profiles.user_id')
      .select([
        'candidate_profiles.user_id',
        'candidate_profiles.full_name',
        'candidate_profiles.region_id',
        'candidate_profiles.district_id',
        'candidate_profiles.available_from',
        'candidate_profiles.visibility',
        'candidate_profiles.completeness_percent',
        'users.phone',
      ])
      .where('candidate_profiles.user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!profile) {
      throw new NotFoundError('candidate.profile_not_found');
    }

    const gate = await this.employers.gate(employerUserId);
    const decision = expose(
      { isVerifiedEmployer: gate.isVerified, isAdmin: false },
      profile.visibility,
      {
        hasApplication: await this.applications.hasApplicationWith(
          employerUserId,
          candidateUserId,
        ),
        // M7's invitations. Passed explicitly rather than defaulted inside the rule, so
        // that adding the second interaction is one line here and no change there.
        hasAcceptedInvitation: false,
      },
    );

    // §11.1: sensitive access is logged. The reason code makes the log answerable -
    // "who saw this candidate's phone number" is a different question from "who looked".
    this.logger.log(
      `Employer ${employerUserId} viewed candidate ${candidateUserId}: ` +
        `contact=${decision.contactDetails} files=${decision.files} (${decision.reason})`,
    );

    return {
      candidateUserId: profile.user_id,
      fullName: profile.full_name,
      regionId: profile.region_id,
      districtId: profile.district_id,
      availableFrom: profile.available_from,
      completenessPercent: profile.completeness_percent,
      phone: exposedPhone(profile.phone, decision),
      canViewFiles: decision.files,
      files: decision.files
        ? await this.filesOf(candidateUserId, applicationId)
        : [],
      exposureReason: decision.reason,
    };
  }

  /**
   * Streams one of the candidate's files to an employer who is entitled to it.
   *
   * §6.5's "authorized CV", and the authorization is BR-09 - re-evaluated here rather
   * than trusted from the listing call, because a client may hold a `downloadPath` from
   * a moment when the interaction still existed. A candidate who withdraws stops the
   * download working, which is the point.
   */
  async downloadForApplication(
    employerUserId: string,
    applicationId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    const view = await this.forApplication(employerUserId, applicationId);

    if (!view.canViewFiles) {
      throw new NotFoundError('file.not_found');
    }

    if (!view.files.some((file) => file.id === fileId)) {
      // Not one of this candidate's files. A 404 rather than a 403: confirming that an
      // id exists elsewhere is information we do not owe (§11.1).
      throw new NotFoundError('file.not_found');
    }

    this.logger.log(
      `Employer ${employerUserId} downloaded file ${fileId} of candidate ` +
        `${view.candidateUserId} via application ${applicationId}`,
    );

    return this.files.readAsAuthorized(view.candidateUserId, fileId);
  }

  /**
   * The candidate's attachments, as paths on this API.
   *
   * Never a storage URL - Telegram's carries the bot token (ARCHITECTURE.md §9). The
   * paths point at the application-scoped download route, not at `/files/:id/content`,
   * which stays owner-only: an employer's entitlement comes from the application, so the
   * route that serves them has to be the one that can see it.
   */
  private async filesOf(candidateUserId: string, applicationId: string) {
    const rows = await this.db
      .selectFrom('stored_files')
      .innerJoin(
        'dictionary_items',
        'dictionary_items.id',
        'stored_files.purpose_id',
      )
      .select([
        'stored_files.id',
        'stored_files.file_name',
        'dictionary_items.code',
      ])
      .where('stored_files.owner_user_id', '=', candidateUserId)
      .where('stored_files.deleted_at', 'is', null)
      .orderBy('stored_files.created_at', 'desc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      purposeCode: row.code,
      fileName: row.file_name,
      downloadPath: `/applications/${applicationId}/files/${row.id}/content`,
    }));
  }
}
