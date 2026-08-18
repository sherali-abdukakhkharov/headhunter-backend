import type { ProfileVisibility } from '@infra/db/database.types';

import {
  type InteractionState,
  expose,
  exposedPhone,
} from './contact-exposure';

/**
 * BR-09, the privacy rule.
 *
 * "Contact information is revealed according to candidate privacy settings **and** an
 * allowed hiring interaction." Both halves, and the failure mode of getting it wrong is
 * leaking phone numbers - so these tests assert the *reason* as well as the outcome. Two
 * rules that deny for different reasons are not the same rule, and a refactor that
 * collapsed them would pass an outcome-only test.
 *
 * M12 added a third granting input, the Candidate Unlock, and it is the first one an
 * employer can obtain without the candidate doing anything. Two of the tests below exist
 * only because of that: the one proving an unlock cannot buy past verification (§7), which
 * is the single way this change could leak a number, and the one proving an unlock survives
 * the candidate hiding their profile, which would otherwise fail silently with nothing but a
 * reason code in a log to show for it.
 */

const VISIBILITIES: ProfileVisibility[] = [
  'searchable',
  'hidden',
  'visible_after_apply',
];

const NOTHING: InteractionState = {
  hasApplication: false,
  hasAcceptedInvitation: false,
  hasUnlock: false,
};

const APPLIED: InteractionState = { ...NOTHING, hasApplication: true };
const INVITED: InteractionState = { ...NOTHING, hasAcceptedInvitation: true };
const UNLOCKED: InteractionState = { ...NOTHING, hasUnlock: true };
const EVERYTHING: InteractionState = {
  hasApplication: true,
  hasAcceptedInvitation: true,
  hasUnlock: true,
};

const VERIFIED = { isVerifiedEmployer: true, isAdmin: false };

describe('expose (BR-09)', () => {
  it('reveals nothing to an unverified employer, whatever the entitlement', () => {
    // §7: only a verified employer may see candidates at all. Neither an application nor a
    // **purchase** changes that - BR-03 is a precondition, not something an applicant can
    // waive or an employer can buy past. This is the one way M12's change could have leaked a
    // phone number, which is why the unlock is in here rather than only in its own test.
    for (const visibility of VISIBILITIES) {
      for (const interaction of [APPLIED, INVITED, UNLOCKED, EVERYTHING]) {
        const decision = expose(
          { isVerifiedEmployer: false, isAdmin: false },
          visibility,
          interaction,
        );

        expect(decision).toEqual({
          contactDetails: false,
          files: false,
          reason: 'not_verified_employer',
        });
      }
    }
  });

  it('reveals nothing to a verified employer holding no entitlement', () => {
    // §11.1: "Phone number and full contact details are not shown in general candidate
    // search cards." Search access alone is never enough - and since M12 the remedy is
    // named: `unlock_required`.
    const decision = expose(VERIFIED, 'searchable', NOTHING);

    expect(decision.contactDetails).toBe(false);
    expect(decision.files).toBe(false);
    expect(decision.reason).toBe('unlock_required');
  });

  it('distinguishes "hidden by the candidate" from "an unlock would fix this"', () => {
    // Same outcome, different cause, and the difference is what the client can offer. One is
    // a candidate who opted out entirely; the other is a purchase away.
    expect(expose(VERIFIED, 'hidden', NOTHING).reason).toBe(
      'hidden_by_candidate',
    );
    expect(expose(VERIFIED, 'searchable', NOTHING).reason).toBe(
      'unlock_required',
    );
  });

  it('reveals contact details and files once the candidate has applied', () => {
    expect(expose(VERIFIED, 'searchable', APPLIED)).toEqual({
      contactDetails: true,
      files: true,
      reason: 'application',
    });
  });

  it('reveals them to a hidden candidate who applied anyway (§5.3)', () => {
    // `hidden` means hidden from *search*: §5.3 lets a candidate "hide the profile from
    // global search while continuing to browse and apply". An applicant who could not be
    // contacted has applied for nothing.
    const decision = expose(VERIFIED, 'hidden', APPLIED);

    expect(decision.contactDetails).toBe(true);
    expect(decision.reason).toBe('application');
  });

  it('accepts an accepted invitation as the entitlement (§8.2)', () => {
    const decision = expose(VERIFIED, 'searchable', INVITED);

    expect(decision.contactDetails).toBe(true);
    expect(decision.reason).toBe('accepted_invitation');
  });

  it('accepts a Candidate Unlock as the entitlement (§6.6, §11.1, BR-17)', () => {
    // §11.1's "successful Candidate Unlock", and it grants exactly what an application
    // grants: an unlock buys the contact details a candidate who applied would have given.
    expect(expose(VERIFIED, 'searchable', UNLOCKED)).toEqual({
      contactDetails: true,
      files: true,
      reason: 'candidate_unlock',
    });
  });

  it('keeps an unlock working after the candidate hides their profile', () => {
    // **The silent-failure case.** An employer who paid, whose candidate then hides, arrives
    // with no application and no invitation. If `hasUnlock` were left out of the
    // no-entitlement condition the branch would fire and return `hidden_by_candidate`,
    // refusing contact that has been paid for - and nothing would fail loudly.
    //
    // It is also the consistent answer: §5.3's `hidden` already does not silence a candidate
    // who applied, and an unlock is a purchase rather than a request a candidate can take
    // back by leaving search.
    for (const visibility of VISIBILITIES) {
      const decision = expose(VERIFIED, visibility, UNLOCKED);

      expect(decision.contactDetails).toBe(true);
      expect(decision.files).toBe(true);
      expect(decision.reason).toBe('candidate_unlock');
    }
  });

  it('reports the strongest claim when more than one applies', () => {
    // All three grant identically, so precedence only decides what the log and the client are
    // told - and an employer holding an application should not be shown a purchase as the
    // reason they are allowed. "Do I hold an entitlement I paid for" is a different question,
    // answered by `GET /wallet/unlocks/:candidateUserId`.
    expect(expose(VERIFIED, 'searchable', EVERYTHING).reason).toBe(
      'application',
    );
    expect(
      expose(VERIFIED, 'searchable', { ...UNLOCKED, hasApplication: true })
        .reason,
    ).toBe('application');
    expect(
      expose(VERIFIED, 'searchable', {
        ...UNLOCKED,
        hasAcceptedInvitation: true,
      }).reason,
    ).toBe('accepted_invitation');
  });

  it('reveals everything to an administrator, and says so', () => {
    // §10.4 and §11.1: complaint review over profiles cannot work without seeing what
    // was reported, so the access is logged rather than blocked - and the reason code is
    // what makes the log meaningful.
    for (const visibility of VISIBILITIES) {
      const decision = expose(
        { isVerifiedEmployer: false, isAdmin: true },
        visibility,
        NOTHING,
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
    // Extended rather than copied when the unlock arrived: the invariant is over *every*
    // combination, and a second test over the new one would have let the pair diverge.
    for (const visibility of VISIBILITIES) {
      for (const interaction of [
        NOTHING,
        APPLIED,
        INVITED,
        UNLOCKED,
        EVERYTHING,
      ]) {
        const decision = expose(VERIFIED, visibility, interaction);

        expect(decision.files).toBe(decision.contactDetails);
      }
    }
  });

  it('never grants on a reason that is meant to deny, or the reverse', () => {
    // The reason is a contract the client renders copy from, so a granting decision carrying
    // a denying code would put "unlock to see this" next to a visible phone number.
    const granting = [
      'admin',
      'application',
      'accepted_invitation',
      'candidate_unlock',
    ];

    for (const visibility of VISIBILITIES) {
      for (const interaction of [NOTHING, APPLIED, INVITED, UNLOCKED]) {
        for (const viewer of [
          VERIFIED,
          { isVerifiedEmployer: false, isAdmin: false },
          { isVerifiedEmployer: false, isAdmin: true },
        ]) {
          const decision = expose(viewer, visibility, interaction);

          expect(granting.includes(decision.reason)).toBe(
            decision.contactDetails,
          );
        }
      }
    }
  });
});

describe('exposedPhone', () => {
  it('returns the number only when the decision allows it', () => {
    const allowed = expose(VERIFIED, 'searchable', APPLIED);
    const bought = expose(VERIFIED, 'searchable', UNLOCKED);
    const denied = expose(VERIFIED, 'searchable', NOTHING);

    expect(exposedPhone('+998901234567', allowed)).toBe('+998901234567');
    expect(exposedPhone('+998901234567', bought)).toBe('+998901234567');
    expect(exposedPhone('+998901234567', denied)).toBeNull();
  });

  it('stays null when there is no number to reveal', () => {
    const allowed = expose(VERIFIED, 'searchable', APPLIED);

    expect(exposedPhone(null, allowed)).toBeNull();
  });
});
