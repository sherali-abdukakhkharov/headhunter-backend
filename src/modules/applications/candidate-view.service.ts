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

/**
 * What entitled this employer to the candidate's files, and therefore which route serves
 * them.
 *
 * The `kind` is the URL segment on purpose: BR-09 grants access through an interaction,
 * and the path a client is handed has to name the interaction it came from so the check
 * can be repeated on every download.
 *
 * An application outranks an accepted invitation when both exist, for no deeper reason
 * than that the application is the stronger claim - the candidate asked - and the two
 * routes serve identical bytes.
 */
interface GrantingInteraction {
  kind: 'applications' | 'invitations';
  id: string;
}

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
    // they withdrew. `applicationWith` is the one place that decides what counts.
    const application = await this.applications.applicationWith(
      employerUserId,
      candidateUserId,
    );
    const invitation = application
      ? null
      : await this.acceptedInvitationWith(employerUserId, candidateUserId);
    const interaction: GrantingInteraction | null = application
      ? { kind: 'applications', id: application }
      : invitation
        ? { kind: 'invitations', id: invitation }
        : null;

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
        // which is what passing both flags explicitly was for.
        hasAcceptedInvitation: interaction?.kind === 'invitations',
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
   * BR-09's second interaction (§8.2): did this employer invite the candidate, and did
   * they accept?
   *
   * Read as a query here rather than through `InvitationsService`, deliberately. The
   * invitations module imports this one - it serves the invitation-scoped download route -
   * and injecting it back would be a circular dependency for one `SELECT`. Reading another
   * module's table is what every service in this codebase already does; a module cycle is
   * a structural problem.
   */
  private async acceptedInvitationWith(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom('invitations')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .where('status', '=', 'accepted')
      .orderBy('responded_at', 'desc')
      .executeTakeFirst();

    return row?.id ?? null;
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
    interaction: GrantingInteraction,
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
