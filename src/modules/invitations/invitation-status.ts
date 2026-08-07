import type { InvitationStatus } from '@infra/db/database.types';

/**
 * The invitation machine (§8.2).
 *
 * Small, because §8.2 is small: an invitation is `sent`, and then "the candidate may
 * Accept, Decline, or Request details". Three things are worth stating rather than
 * leaving to be read off the enum.
 *
 * - **Every transition is the candidate's.** Unlike §8.1's application stages, there is
 *   no column here for who may set what, because there is only one answer - which is why
 *   the route is `@RequireRole('candidate')` and the service checks that the invitation
 *   is theirs rather than consulting a table.
 * - **`details_requested` is not an ending.** It is a question, and the candidate may
 *   still accept or decline afterwards; what they may not do is ask twice, which would
 *   produce a history of identical rows saying nothing happened.
 * - **There is no `withdrawn` and no `expired`.** Neither is in the specification, and a
 *   status nothing can set is a state every reader has to consider for nothing. An
 *   employer who changes their mind stops replying; §9.1's read-only rule is what closes
 *   the conversation.
 */

/** Once here, the invitation has been answered and nothing more can change it. */
const TERMINAL: InvitationStatus[] = ['accepted', 'declined'];

/** §8.2's three actions, in the order the client shows them. */
export const CANDIDATE_RESPONSES: InvitationStatus[] = [
  'accepted',
  'declined',
  'details_requested',
];

export function isTerminal(status: InvitationStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * May the candidate move an invitation from `from` to `to`?
 *
 * `to !== from` is what refuses a second "request details" - and, incidentally, an
 * accept of something already accepted, which a retrying client would otherwise turn
 * into a second history row.
 */
export function canRespond(
  from: InvitationStatus,
  to: InvitationStatus,
): boolean {
  return !isTerminal(from) && CANDIDATE_RESPONSES.includes(to) && to !== from;
}

/**
 * Does this status keep the "one open invitation" slot occupied?
 *
 * Mirrors the partial unique index exactly, and is exported so a test can assert the two
 * against each other rather than trust them to agree: they are the same rule written
 * twice, in two languages.
 */
export function occupiesOpenSlot(status: InvitationStatus): boolean {
  return status === 'sent' || status === 'details_requested';
}
