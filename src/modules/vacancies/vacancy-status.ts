import type { VacancyStatus } from '@infra/db/database.types';

/**
 * The vacancy status machine (§6.4, ARCHITECTURE.md §6).
 *
 * Pure, so the transition table is one readable thing rather than a set of `if`s
 * spread through a service. Every transition the service performs is checked against
 * it, and every one writes a `vacancy_status_history` row (BR-08).
 *
 *   draft            → under_moderation | active
 *   under_moderation → active | rejected
 *   rejected         → draft
 *   active           → paused | closed
 *   paused           → active | closed
 *   closed           → (terminal, BR-11: leaves discovery, stays in history)
 *
 * `draft → active` exists only because `MODERATION_ENABLED` may be off - see
 * `VacanciesService.submit` for why that flag exists and what it deliberately does
 * *not* cover.
 */
const TRANSITIONS: Record<VacancyStatus, VacancyStatus[]> = {
  draft: ['under_moderation', 'active'],
  under_moderation: ['active', 'rejected'],
  rejected: ['draft'],
  active: ['paused', 'closed', 'under_moderation'],
  paused: ['active', 'closed', 'under_moderation'],
  // Terminal. BR-11 keeps a closed vacancy in history rather than deleting it, and
  // reopening one would make "closed" mean nothing to the candidates who saw it.
  closed: [],
};

export function canTransition(from: VacancyStatus, to: VacancyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * May the employer still edit the content?
 *
 * `under_moderation` is excluded because a moderator is reading it: an edit mid-review
 * would have them approve something other than what they saw. `closed` is excluded
 * because BR-11 keeps it as history.
 */
export function isEditable(status: VacancyStatus): boolean {
  return (
    status === 'draft' ||
    status === 'rejected' ||
    status === 'active' ||
    status === 'paused'
  );
}

/** Statuses a submission may start from. */
export function canSubmitFrom(status: VacancyStatus): boolean {
  return status === 'draft' || status === 'rejected';
}

/**
 * Is this vacancy accepting applications right now?
 *
 * BR-06 in one place: active, and either no deadline or one that has not passed.
 * M6's discovery filter and its in-transaction application check both read this
 * definition rather than restating it - the alternative is a vacancy that appears in
 * the feed and refuses the application it invited.
 *
 * @param today the platform zone's date, as `'YYYY-MM-DD'`. Passed in because
 *   "today" depends on a configured zone, and a rule that cannot be given a fixed
 *   today cannot be tested.
 */
export function isOpenForApplications(
  status: VacancyStatus,
  deadlineOn: string | null,
  today: string,
): boolean {
  if (status !== 'active') {
    return false;
  }

  // Lexicographic comparison, which is exactly right for ISO dates - no parsing and
  // no zone enters it.
  return deadlineOn === null || deadlineOn >= today;
}

/** The BR-12 restriction kinds a vacancy actually states. */
export function restrictionKinds(vacancy: {
  age_min: number | null;
  age_max: number | null;
  gender_id: string | null;
}): ('age' | 'gender')[] {
  const kinds: ('age' | 'gender')[] = [];

  if (vacancy.age_min !== null || vacancy.age_max !== null) {
    kinds.push('age');
  }

  if (vacancy.gender_id !== null) {
    kinds.push('gender');
  }

  return kinds;
}

/** Recorded as the reason when no moderator exists to approve a vacancy (BR-04). */
export const AUTO_APPROVED_REASON = 'auto_approved_no_moderator';

/** Recorded when an edit to a BR-12 restriction sends a live vacancy back for review. */
export const RESTRICTION_CHANGED_REASON = 'restriction_changed_requires_review';
