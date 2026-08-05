import type { ApplicationStatus } from '@infra/db/database.types';

/**
 * The application stage machine (§8.1, §5.6, ARCHITECTURE.md §6).
 *
 * §8.1 lists the eight stages and, for each, **who may set it**. That column is the
 * reason this is a table rather than a linear progression: `withdrawn` is the
 * candidate's alone and everything from `viewed` onward is the employer's, so
 * "may this transition happen" and "may *you* make it happen" are two questions.
 *
 * Forward moves may skip stages. Real hiring does - an employer who already knows a
 * candidate goes straight from `submitted` to `offer` - and §8.1 lists stages without
 * requiring each to be visited. Backwards moves are refused: a candidate told they were
 * shortlisted and then returned to `viewed` has been told something false, and the
 * history would be the only record of it.
 */
const PROGRESSION: ApplicationStatus[] = [
  'submitted',
  'viewed',
  'shortlisted',
  'interview',
  'offer',
  'hired',
];

/** Stages from which the interaction is still live. */
const TERMINAL: ApplicationStatus[] = ['hired', 'rejected', 'withdrawn'];

export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  if (isTerminal(from) || from === to) {
    return false;
  }

  // Reachable from any live stage: §8.1 gives the employer `rejected` throughout, and
  // §5.6 lets the candidate withdraw "before an accepted offer" - which `hired` being
  // terminal already expresses.
  if (to === 'rejected' || to === 'withdrawn') {
    return true;
  }

  const fromIndex = PROGRESSION.indexOf(from);
  const toIndex = PROGRESSION.indexOf(to);

  return fromIndex !== -1 && toIndex > fromIndex;
}

/**
 * Who may set this stage (§8.1's second column).
 *
 * `submitted` is nobody's transition - it is what creating an application *is*.
 */
export function actorFor(
  to: ApplicationStatus,
): 'employer' | 'candidate' | null {
  if (to === 'withdrawn') {
    return 'candidate';
  }

  if (to === 'submitted') {
    return null;
  }

  return 'employer';
}

/** The stages an employer may move an application to, for the route's DTO. */
export const EMPLOYER_STAGES: ApplicationStatus[] = [
  'viewed',
  'shortlisted',
  'interview',
  'offer',
  'hired',
  'rejected',
];

/**
 * Does this status keep the BR-07 slot occupied?
 *
 * Mirrors the partial unique index exactly. Exported so the service and the index can be
 * asserted against each other in a test rather than trusted to agree - they are the same
 * rule written twice, in two languages.
 */
export function occupiesActiveSlot(status: ApplicationStatus): boolean {
  return status !== 'withdrawn' && status !== 'rejected';
}
