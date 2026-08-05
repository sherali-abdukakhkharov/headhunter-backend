import type { ProfileVisibility } from '@infra/db/database.types';

import { expose, exposedPhone } from './contact-exposure';

/**
 * BR-09, the privacy rule.
 *
 * "Contact information is revealed according to candidate privacy settings **and** an
 * allowed hiring interaction." Both halves, and the failure mode of getting it wrong is
 * leaking phone numbers - so these tests assert the *reason* as well as the outcome. Two
 * rules that deny for different reasons are not the same rule, and a refactor that
 * collapsed them would pass an outcome-only test.
 */

const VISIBILITIES: ProfileVisibility[] = [
  'searchable',
  'hidden',
  'visible_after_apply',
];

const NO_INTERACTION = {
  hasApplication: false,
  hasAcceptedInvitation: false,
};

const VERIFIED = { isVerifiedEmployer: true, isAdmin: false };

describe('expose (BR-09)', () => {
  it('reveals nothing to an unverified employer, whatever the interaction', () => {
    // §7: only a verified employer may see candidates at all. An application does not
    // change that - BR-03 is a precondition, not something an applicant can waive.
    for (const visibility of VISIBILITIES) {
      const decision = expose(
        { isVerifiedEmployer: false, isAdmin: false },
        visibility,
        { hasApplication: true, hasAcceptedInvitation: true },
      );

      expect(decision).toEqual({
        contactDetails: false,
        files: false,
        reason: 'not_verified_employer',
      });
    }
  });

  it('reveals nothing to a verified employer with no interaction', () => {
    // §11.1: "Phone number and full contact details are not shown in general candidate
    // search cards." Search access alone is never enough.
    const decision = expose(VERIFIED, 'searchable', NO_INTERACTION);

    expect(decision.contactDetails).toBe(false);
    expect(decision.files).toBe(false);
    expect(decision.reason).toBe('no_interaction');
  });

  it('distinguishes "hidden by the candidate" from "no interaction yet"', () => {
    // Same outcome, different cause. The reason is logged (§11.1) and answers a real
    // question: was this employer refused, or has the candidate opted out entirely?
    expect(expose(VERIFIED, 'hidden', NO_INTERACTION).reason).toBe(
      'hidden_by_candidate',
    );
    expect(expose(VERIFIED, 'searchable', NO_INTERACTION).reason).toBe(
      'no_interaction',
    );
  });

  it('reveals contact details and files once the candidate has applied', () => {
    const decision = expose(VERIFIED, 'searchable', {
      hasApplication: true,
      hasAcceptedInvitation: false,
    });

    expect(decision).toEqual({
      contactDetails: true,
      files: true,
      reason: 'application',
    });
  });

  it('reveals them to a hidden candidate who applied anyway (§5.3)', () => {
    // `hidden` means hidden from *search*: §5.3 lets a candidate "hide the profile from
    // global search while continuing to browse and apply". An applicant who could not be
    // contacted has applied for nothing.
    const decision = expose(VERIFIED, 'hidden', {
      hasApplication: true,
      hasAcceptedInvitation: false,
    });

    expect(decision.contactDetails).toBe(true);
    expect(decision.reason).toBe('application');
  });

  it('accepts an accepted invitation as the interaction (§8.2)', () => {
    const decision = expose(VERIFIED, 'searchable', {
      hasApplication: false,
      hasAcceptedInvitation: true,
    });

    expect(decision.contactDetails).toBe(true);
    expect(decision.reason).toBe('accepted_invitation');
  });

  it('reveals everything to an administrator, and says so', () => {
    // §10.4 and §11.1: complaint review over profiles cannot work without seeing what
    // was reported, so the access is logged rather than blocked - and the reason code is
    // what makes the log meaningful.
    for (const visibility of VISIBILITIES) {
      const decision = expose(
        { isVerifiedEmployer: false, isAdmin: true },
        visibility,
        NO_INTERACTION,
      );

      expect(decision).toEqual({
        contactDetails: true,
        files: true,
        reason: 'admin',
      });
    }
  });

  it('treats files and contact details as one decision', () => {
    // §5.4 ("files visible only to authorized employers") and §11.1 draw the same line,
    // so a state where one is allowed and the other is not would be a rule nobody wrote.
    for (const visibility of VISIBILITIES) {
      for (const interaction of [
        NO_INTERACTION,
        { hasApplication: true, hasAcceptedInvitation: false },
        { hasApplication: false, hasAcceptedInvitation: true },
      ]) {
        const decision = expose(VERIFIED, visibility, interaction);

        expect(decision.files).toBe(decision.contactDetails);
      }
    }
  });
});

describe('exposedPhone', () => {
  it('returns the number only when the decision allows it', () => {
    const allowed = expose(VERIFIED, 'searchable', {
      hasApplication: true,
      hasAcceptedInvitation: false,
    });
    const denied = expose(VERIFIED, 'searchable', NO_INTERACTION);

    expect(exposedPhone('+998901234567', allowed)).toBe('+998901234567');
    expect(exposedPhone('+998901234567', denied)).toBeNull();
  });

  it('stays null when there is no number to reveal', () => {
    const allowed = expose(VERIFIED, 'searchable', {
      hasApplication: true,
      hasAcceptedInvitation: false,
    });

    expect(exposedPhone(null, allowed)).toBeNull();
  });
});
