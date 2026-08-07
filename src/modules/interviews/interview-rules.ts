import type { InterviewStatus, InterviewType } from '@infra/db/database.types';

/**
 * §8.3's two rules, as pure functions.
 *
 * The table in §8.3 is mostly fields, and fields belong to the schema. What is *logic*
 * is this: which detail each interview type requires, and what the candidate may do with
 * an interview once it exists. Both are here rather than in the service so they can be
 * pinned by a test that needs no database - and so the CHECK constraint that enforces the
 * first one has a readable twin to be compared against.
 */

export interface InterviewDetails {
  type: InterviewType;
  location?: string | null;
  meetingLink?: string | null;
}

/**
 * "Location / link: **required according to interview type**" (§8.3).
 *
 * Returns the field code that is wrong, or null when the shape is right. A code rather
 * than a message, because the caller turns it into a localized field violation and the
 * client focuses the field.
 *
 * Each type permits exactly one shape, and the *absence* is checked as well as the
 * presence: a phone interview carrying a meeting link is not a phone interview, and
 * leaving it stored would show the candidate a link nobody meant them to use.
 */
export function detailViolation(
  details: InterviewDetails,
): 'location' | 'meetingLink' | null {
  const location = details.location?.trim() ? details.location : null;
  const meetingLink = details.meetingLink?.trim() ? details.meetingLink : null;

  switch (details.type) {
    case 'in_person':
      if (!location) {
        return 'location';
      }

      return meetingLink ? 'meetingLink' : null;
    case 'external_link':
      if (!meetingLink) {
        return 'meetingLink';
      }

      return location ? 'location' : null;
    default:
      // Phone: the number is the candidate's own, already on their profile, and asking
      // an employer to retype it would be a second copy of a verified value (BR-01).
      if (location) {
        return 'location';
      }

      return meetingLink ? 'meetingLink' : null;
  }
}

/** Once here, the interview is over as a decision - nothing more can change it. */
const TERMINAL: InterviewStatus[] = ['cancelled'];

/** §8.3's "Candidate response: confirm or request another time". */
export const CANDIDATE_RESPONSES: InterviewStatus[] = [
  'confirmed',
  'reschedule_requested',
];

export function isTerminal(status: InterviewStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * May the candidate move an interview from `from` to `to`?
 *
 * Confirming twice is refused, as is asking twice for another time: both would add a
 * history row saying nothing happened. Changing one's mind the other way is allowed - a
 * candidate who confirmed and then found a clash must be able to say so, and that is the
 * whole reason `confirmed` is not terminal.
 */
export function canRespond(
  from: InterviewStatus,
  to: InterviewStatus,
): boolean {
  return !isTerminal(from) && CANDIDATE_RESPONSES.includes(to) && to !== from;
}

/**
 * Does rescheduling reset the candidate's answer?
 *
 * Yes, always: an interview moved to another time has not been confirmed, whatever was
 * said about the old one. Stated as a function because the alternative - remembering to
 * write `status: 'scheduled'` at each of the employer's two edit paths - is how a
 * confirmation ends up attached to a time the candidate never saw.
 */
export function statusAfterReschedule(): InterviewStatus {
  return 'scheduled';
}
