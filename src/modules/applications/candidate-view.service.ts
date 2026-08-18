import { Inject, Injectable, Logger } from '@nestjs/common';

import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { type Database, KYSELY } from '@infra/db/database.module';
import {
  type ExposureDecision,
  expose,
  exposedPhone,
} from '@infra/privacy/contact-exposure';
import {
  type HiringInteraction,
  HiringInteractionService,
} from '@infra/privacy/hiring-interaction.service';
import { EmployersService } from '@modules/employers/employers.service';

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
    private readonly interactions: HiringInteractionService,
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

    return this.read(employerUserId, application.candidate_user_id);
  }

  /**
   * §7.3's "View profile", reached from a candidate search rather than an application.
   *
   * Readable in two cases and no others: the profile is **findable** (BR-02's gate -
   * searchable and complete, the same predicate the search itself starts from), or a
   * hiring interaction already exists. The second case is what keeps an applicant
   * readable after they hide their profile: they applied, and §5.3's "hide from global
   * search" was never a promise to stop the employer they wrote to from reading them.
   *
   * BR-09 still decides the contact details and the files - being *readable* and being
   * *contactable* are different questions, and a card-shaped read of a searchable
   * stranger yields no phone number at all (§11.1).
   */
  async forCandidate(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<CandidateForEmployer> {
    return this.read(employerUserId, candidateUserId);
  }

  private async read(
    employerUserId: string,
    candidateUserId: string,
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
        'candidate_profiles.is_complete',
        'candidate_profiles.completeness_percent',
        'users.phone',
      ])
      .where('candidate_profiles.user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!profile) {
      throw new NotFoundError('candidate.profile_not_found');
    }

    // The interaction, and the route that may serve its files: an employer's entitlement
    // comes from the interaction, so whatever granted it is what the download path is
    // scoped to.
    //
    // Derived from the data every time, **never from the application id in the URL**: a
    // withdrawn application is still addressable, and trusting the path would let a
    // candidate's withdrawal be undone by requesting the view through the application
    // they withdrew. `HiringInteractionService` is the one place that decides what counts,
    // and §9.1's chat gate asks it the same question.
    const interaction: HiringInteraction | null =
      await this.interactions.between(employerUserId, candidateUserId);

    // BR-02's gate decides *readability*, and an interaction overrides it: a candidate
    // who hides their profile leaves search, not the conversation they started by
    // applying. Without either, this employer should not learn the profile exists.
    if (!(profile.visibility === 'searchable' && profile.is_complete)) {
      if (!interaction) {
        throw new NotFoundError('candidate.profile_not_found');
      }
    }

    const gate = await this.employers.gate(employerUserId);
    const decision = expose(
      { isVerifiedEmployer: gate.isVerified, isAdmin: false },
      profile.visibility,
      {
        hasApplication: interaction?.kind === 'applications',
        // M7's invitations, and adding them was one line here and no change to the rule -
        // which is what passing the flags explicitly was for. M12's unlock was one more.
        hasAcceptedInvitation: interaction?.kind === 'invitations',
        hasUnlock: interaction?.kind === 'unlocks',
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
      // `decision.files` cannot be true without an interaction (that is the rule), so
      // the path base always exists when there is something to serve.
      files:
        decision.files && interaction
          ? await this.filesOf(candidateUserId, interaction)
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
   * Streams a file to an employer whose entitlement came from an **accepted invitation**
   * (§8.2, BR-09).
   *
   * The invitation's counterpart to `downloadForApplication`, and separate for the same
   * reason: the entitlement comes from the interaction, so the route that serves the bytes
   * has to be the one that can see it. Re-evaluated per download, so a rule that stops
   * holding stops the download - the path a client is holding is not the authorization.
   */
  async downloadForInvitation(
    employerUserId: string,
    invitationId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    const invitation = await this.db
      .selectFrom('invitations')
      .select('candidate_user_id')
      .where('id', '=', invitationId)
      .where('employer_user_id', '=', employerUserId)
      .where('status', '=', 'accepted')
      .executeTakeFirst();

    // One 404 for "no such invitation", "not yours" and "not accepted": which it was is
    // not information we owe (§11.1).
    if (!invitation) {
      throw new NotFoundError('file.not_found');
    }

    const view = await this.read(employerUserId, invitation.candidate_user_id);

    if (!view.canViewFiles || !view.files.some((file) => file.id === fileId)) {
      throw new NotFoundError('file.not_found');
    }

    this.logger.log(
      `Employer ${employerUserId} downloaded file ${fileId} of candidate ` +
        `${view.candidateUserId} via invitation ${invitationId}`,
    );

    return this.files.readAsAuthorized(view.candidateUserId, fileId);
  }

  /**
   * Streams a file to an employer whose entitlement came from a **Candidate Unlock**
   * (§6.6, §11.1, BR-17).
   *
   * The third of these, and the third for the same reason: `downloadPath` is scoped to
   * whatever granted the entitlement, so a third kind of entitlement needs a third route.
   * It is keyed on the candidate rather than on an interaction id because the unlock *is*
   * the pair - `candidate_unlocks` has no surrogate key (BR-16).
   *
   * The unlock is checked first, and its absence is the same `file.not_found` as an unknown
   * file. That is deliberate: an employer holding an application downloads through
   * `/applications/...`, so reaching here without an unlock says nothing about whether the
   * candidate or the file exists, and we do not owe that (§11.1).
   *
   * Re-evaluated per download, like the other two. An unlock cannot be revoked - which makes
   * this the one entitlement where re-checking will not change its mind - but the *file* can
   * be deleted or replaced, and `read()` is what notices.
   */
  async downloadForUnlock(
    employerUserId: string,
    candidateUserId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    const unlock = await this.db
      .selectFrom('candidate_unlocks')
      .select('candidate_user_id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (!unlock) {
      throw new NotFoundError('file.not_found');
    }

    const view = await this.read(employerUserId, candidateUserId);

    if (!view.canViewFiles || !view.files.some((file) => file.id === fileId)) {
      throw new NotFoundError('file.not_found');
    }

    this.logger.log(
      `Employer ${employerUserId} downloaded file ${fileId} of candidate ` +
        `${candidateUserId} via a Candidate Unlock`,
    );

    return this.files.readAsAuthorized(candidateUserId, fileId);
  }

  /**
   * The candidate's attachments, as paths on this API.
   *
   * Never a storage URL - Telegram's carries the bot token (ARCHITECTURE.md §9). The
   * paths are scoped to the **interaction that granted them**, not to
   * `/files/:id/content`, which stays owner-only: an employer's entitlement comes from
   * the application or the accepted invitation, so the route that serves them has to be
   * the one that can see it.
   */
  private async filesOf(
    candidateUserId: string,
    interaction: HiringInteraction,
  ) {
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
      downloadPath: `/${interaction.kind}/${interaction.id}/files/${row.id}/content`,
    }));
  }
}
