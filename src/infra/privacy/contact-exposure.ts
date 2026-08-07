import type { ProfileVisibility } from '@infra/db/database.types';

/**
 * BR-09: whether an employer may see a candidate's contact details and files.
 *
 * "Contact information is revealed according to candidate privacy settings **and** an
 * allowed hiring interaction." Both halves, and this is the only place either is
 * evaluated - ARCHITECTURE.md §8 puts it plainly: a privacy rule duplicated across
 * endpoints will drift, and the failure mode is leaking phone numbers.
 *
 * It was deliberately not built in M3, where the candidate profile landed: two of its
 * three inputs did not exist yet. There was no employer profile until M4 and no
 * application until M6, so "an allowed hiring interaction" had nothing to read and the
 * rule could only have been tested against invented inputs. Until now a CV was readable
 * only by its owner - stricter than BR-09 requires, so nothing was exposed in the
 * meantime.
 *
 * §11.1 adds the constraint that makes this a *rule* rather than a preference: "Phone
 * number and full contact details are not shown in general candidate search cards."
 * A card is not an interaction, so no amount of search access reveals a phone number -
 * which is why `CandidateSearchCard` in M7 must be built from `expose()`'s output and
 * never from the profile row.
 */

/** What an employer is doing with this candidate, as far as the platform knows. */
export interface InteractionState {
  /** The candidate applied to one of this employer's vacancies (§8.1). */
  hasApplication: boolean;
  /** This employer invited the candidate and they accepted (§8.2). M7. */
  hasAcceptedInvitation: boolean;
}

export interface Viewer {
  /** §7: only a verified employer may see candidates at all. */
  isVerifiedEmployer: boolean;
  /** §10: administrators see contact details for moderation (§11.1 logs the access). */
  isAdmin: boolean;
}

export interface ExposureDecision {
  /** Phone number and any other direct contact detail. */
  contactDetails: boolean;
  /** CV, certificates and other candidate files (§5.4 "visible only to authorized employers"). */
  files: boolean;
  /**
   * Why, as a stable code. Returned so a route can log the decision (§11.1 "access to
   * protected data is logged") and so a test can assert the *reason* rather than only
   * the outcome - two rules that both deny for different reasons are not the same rule.
   */
  reason:
    | 'admin'
    | 'application'
    | 'accepted_invitation'
    | 'not_verified_employer'
    | 'no_interaction'
    | 'hidden_by_candidate';
}

/**
 * The single BR-09 decision.
 *
 * Pure, so every caller passes the same three things and gets the same answer, and so
 * the rule is testable without a database.
 */
export function expose(
  viewer: Viewer,
  visibility: ProfileVisibility,
  interaction: InteractionState,
): ExposureDecision {
  // §10.4 and §11.1: administration is a mobile role with moderation duties, and
  // complaint review over profiles cannot work without seeing what was reported. The
  // access is logged rather than blocked.
  if (viewer.isAdmin) {
    return { contactDetails: true, files: true, reason: 'admin' };
  }

  if (!viewer.isVerifiedEmployer) {
    return {
      contactDetails: false,
      files: false,
      reason: 'not_verified_employer',
    };
  }

  // The candidate's own setting comes first. `hidden` means hidden from *search*
  // (§5.3: "hide the profile from global search while continuing to browse and
  // apply"), so it must not silence a candidate who then applies - an applicant who
  // could not be contacted has applied for nothing.
  if (!interaction.hasApplication && !interaction.hasAcceptedInvitation) {
    return {
      contactDetails: false,
      files: false,
      reason:
        visibility === 'hidden' ? 'hidden_by_candidate' : 'no_interaction',
    };
  }

  return {
    contactDetails: true,
    files: true,
    reason: interaction.hasApplication ? 'application' : 'accepted_invitation',
  };
}

/**
 * Applies the decision to a phone number.
 *
 * A helper rather than a convention, because "remember to null the phone" is exactly the
 * kind of thing that gets forgotten in the fifth serializer.
 */
export function exposedPhone(
  phone: string | null,
  decision: ExposureDecision,
): string | null {
  return decision.contactDetails ? phone : null;
}
