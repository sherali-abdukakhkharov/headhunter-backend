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
 *
 * **M12 added a third way to be entitled, and it is the first one an employer can obtain
 * alone.** §11.1 now says contact and CV become available "only after a successful Candidate
 * Unlock or another explicitly approved entitlement", and **an application is read as one of
 * those** - a candidate who applied to this employer volunteered contact with them, which is
 * §11.1's own escape hatch and leaves M6, M7 and M8 as delivered. An accepted invitation is
 * treated identically, as it already was. The unlock is therefore *for candidates who have
 * not applied*: it buys what an application would have granted.
 *
 * That reading is the team's, not the client's. §9.1 as written says an application is not
 * an approved entitlement, and if the client ever insists on that, the change is much larger
 * than adding a flag here: it inverts the meaning of two of the reason codes below and
 * reaches into M6, M7 and M8. Recorded in ARCHITECTURE.md §13 and in TODO.md rather than
 * left as an assumption in a helper.
 */

/** What an employer is doing with this candidate, as far as the platform knows. */
export interface InteractionState {
  /** The candidate applied to one of this employer's vacancies (§8.1). */
  hasApplication: boolean;
  /** This employer invited the candidate and they accepted (§8.2). M7. */
  hasAcceptedInvitation: boolean;
  /**
   * This employer bought a Candidate Unlock for this candidate (§6.6, BR-17). M12.
   *
   * The third granting input, and the first one the employer can obtain unilaterally: the
   * other two need the candidate to have done something. That is what makes it §11.1's
   * "successful Candidate Unlock" rather than a hiring interaction, and why it grants the
   * same two things rather than something new - an unlock buys the contact details an
   * application would have revealed, for a candidate who has not applied.
   */
  hasUnlock: boolean;
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
    | 'candidate_unlock'
    | 'not_verified_employer'
    | 'unlock_required'
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

  // **This short-circuits before the unlock is even looked at, and it must stay that way.**
  // §7 says only a verified employer may see candidates at all, and BR-03 is a
  // precondition rather than something an applicant can waive - or a purchase can buy past.
  // An unverified employer who somehow held an unlock would otherwise be the one way this
  // rule leaks a phone number, which is why the test asserting it enumerates every
  // interaction including the unlock.
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
  //
  // **`hasUnlock` belongs in this condition, and leaving it out fails silently.** An
  // employer who paid, whose candidate then hid their profile, arrives with no application
  // and no invitation; without the unlock in this test the branch fires and returns
  // `hidden_by_candidate` - refusing contact that has been paid for, with a log line as the
  // only symptom. An unlock is a purchase, not a request the candidate can withdraw by
  // leaving search. `expose survives visibility: 'hidden'` is the test that pins it.
  if (
    !interaction.hasApplication &&
    !interaction.hasAcceptedInvitation &&
    !interaction.hasUnlock
  ) {
    return {
      contactDetails: false,
      files: false,
      reason:
        visibility === 'hidden' ? 'hidden_by_candidate' : 'unlock_required',
    };
  }

  return {
    contactDetails: true,
    files: true,
    // Precedence, and it is the same order `HiringInteractionService` reports: the
    // candidate's own application is the strongest claim, then an invitation they accepted,
    // then something the employer bought. All three grant identically, so this only decides
    // what the log and the client are told - and "why am I allowed" is worth answering
    // precisely, because an employer who holds an application should not be shown a
    // purchase as the reason.
    reason: interaction.hasApplication
      ? 'application'
      : interaction.hasAcceptedInvitation
        ? 'accepted_invitation'
        : 'candidate_unlock',
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
