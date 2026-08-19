/**
 * The permitted reasons for an age or gender restriction (BR-12, §7.1).
 *
 * BR-12: "Age or gender restrictions require an objective reason, administrator
 * review, and an audit record." Moderation has to **validate** the reason, which
 * means it must come from an enumerated list - free prose cannot be validated, and a
 * text box would collect "young team" and "we prefer men" and leave a moderator to
 * argue about them one at a time.
 *
 * **This list was the second open client decision, answered as data.** Like the
 * employer evidence rules, every entry carries a provenance tag and a note, so the
 * client's approved list is one edit to one file - no migration, no endpoint, no
 * client release. **The client approved the list as written on 2026-08-20**, which is
 * why the tags read `client`.
 *
 * The list is deliberately short and each entry names an objective condition of the
 * work rather than a preference about the worker. Two consequences worth stating:
 *
 * - **A restriction is only as legitimate as its reason.** These describe statutory
 *   limits and physical facts of a workplace. A commercial or customer preference is
 *   not on the list and must not be added without legal advice: it is precisely the
 *   discrimination BR-12 exists to catch, and putting it here would make the platform
 *   the instrument of it.
 * - **The `note` an employer writes is elaboration, never the justification itself.**
 *   A moderator reads it; the code is what the system checks.
 *
 * **What the approval is, and what it is not.** Uzbek labour law is the source these
 * are drawn from in outline, and **nothing here has been reviewed by a lawyer.** The
 * client was told that in those words on 2026-08-20 and chose to proceed with the list
 * as it stands, so `client` here means "approved for use by the party who owns the
 * policy", not "checked by counsel". The recommendation is not withdrawn by the
 * approval: `hazardous_conditions` and `heavy_lifting_limits` both turn on statutory
 * norms this team read in outline and cannot cite, and both are broad enough that a
 * wrong reading readmits the discrimination BR-12 exists to forbid. A lawyer should
 * still see this file before the platform carries volume. Recording that here rather
 * than only in a commit message is the point of the tag.
 *
 * **Labels are not here.** The four localized labels live in the
 * `restriction_justification` dictionary, like every other selectable value (BR-13),
 * so the employer's picker renders without this file. What stays here is the *rule* -
 * which reason can support which restriction - deliberately in code rather than in a
 * seeded `item_group`: a dictionary row is admin-editable (§10.3), and widening BR-12
 * must not be something an administrator can do by editing content. A test asserts the
 * two sets of codes match exactly.
 */

export type JustificationProvenance = 'spec' | 'client' | 'default';

export interface RestrictionJustification {
  code: string;
  /** Which restriction kinds this reason can support. */
  applies: ('age' | 'gender')[];
  provenance: JustificationProvenance;
  note: string;
}

export const RESTRICTION_JUSTIFICATIONS: RestrictionJustification[] = [
  {
    code: 'statutory_minimum_age',
    applies: ['age'],
    provenance: 'client',
    note:
      'Some work has a legal age floor above the platform minimum - operating ' +
      'machinery, work involving alcohol or tobacco, security roles. The clearest ' +
      'legitimate case, and the only one where an age floor is objective rather ' +
      'than a preference.',
  },
  {
    code: 'night_work_restriction',
    applies: ['age'],
    provenance: 'client',
    note:
      'Night shifts are restricted for workers under 18. An age restriction on a ' +
      'night-shift vacancy follows from the schedule, not from a preference - which ' +
      'is why a moderator should check that the vacancy actually is night work.',
  },
  {
    code: 'hazardous_conditions',
    applies: ['age', 'gender'],
    provenance: 'client',
    note:
      'Statutory limits apply to minors and, in some jurisdictions, to specific ' +
      'hazardous work. Left applicable to both kinds because the law does, but this ' +
      'is the entry most in need of legal review: a broad reading of it would ' +
      'readmit exactly the discrimination BR-12 forbids.',
  },
  {
    code: 'heavy_lifting_limits',
    applies: ['age', 'gender'],
    provenance: 'client',
    note:
      'Manual-handling weight limits differ by age and, under Uzbek norms, by sex. ' +
      'A moderator should require the vacancy to state the actual weights - the ' +
      'limit justifies a restriction only where the work genuinely exceeds it.',
  },
  {
    code: 'single_sex_facility',
    applies: ['gender'],
    provenance: 'client',
    note:
      'Personal care, changing rooms, women-only facilities, and similar settings ' +
      'where the sex of the worker is a genuine requirement of the role rather than ' +
      'a preference about who does it. Narrow on purpose.',
  },
];

const BY_CODE = new Map(
  RESTRICTION_JUSTIFICATIONS.map((item) => [item.code, item]),
);

/** Is this code permitted for the restriction the vacancy actually states? */
export function isJustificationValid(
  code: string,
  kinds: ('age' | 'gender')[],
): boolean {
  const justification = BY_CODE.get(code);

  if (!justification) {
    return false;
  }

  // Every kind of restriction present must be one this reason can support. A
  // gender restriction justified by a minimum-age rule is not justified at all.
  return kinds.every((kind) => justification.applies.includes(kind));
}

export function justificationCodes(): string[] {
  return RESTRICTION_JUSTIFICATIONS.map((item) => item.code);
}
