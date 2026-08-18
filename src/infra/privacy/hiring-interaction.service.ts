import { Inject, Injectable } from '@nestjs/common';

import { type Database, KYSELY } from '@infra/db/database.module';

/**
 * What entitles an employer to something of a candidate's, and through which resource.
 *
 * The `kind` is the URL segment on purpose: an entitlement granted by an interaction has
 * to be served by a route scoped to that interaction, so the check can be repeated on
 * every request rather than trusted from a path the client is holding.
 */
export interface HiringInteraction {
  kind: 'applications' | 'invitations' | 'unlocks';
  /**
   * What the route serving this entitlement is scoped to.
   *
   * An application or invitation id for those two. For an unlock it is the
   * **candidate's user id**: `candidate_unlocks` has no surrogate key, because the pair is
   * its primary key - which is what makes BR-16 true without a check.
   */
  id: string;
}

/**
 * "Is there a live hiring interaction between these two people?"
 *
 * One question, three callers, and they must not be able to disagree:
 *
 * - **BR-09** (§11.1): whether an employer may see a candidate's phone number and files.
 * - **§9.1's chat gate**: "Chat becomes available after an application, invitation, or
 *   other permitted hiring interaction."
 * - **§9.1's read-only rule**: a conversation whose interaction has ended stays readable
 *   and stops accepting messages.
 *
 * It lived as a method on `ApplicationsService` and a private query in
 * `CandidateViewService` until M8 needed it a third time, which is the point CLAUDE.md
 * names for extracting a repetition. The alternative was a third copy and, eventually, an
 * employer who could read a phone number but not send a message - or worse, the reverse.
 *
 * It sits in `infra/privacy`, beside the rule it feeds, and reads the two domain tables
 * directly. That is deliberate: a service here has no module dependencies, so nothing can
 * end up in a cycle around it, and every module that needs the answer imports one small
 * thing.
 *
 * **What counts, and why:**
 *
 * - An application in any status **except `withdrawn`**. A candidate who applied asked to
 *   be contacted; withdrawing takes that back. A rejection does not - an employer
 *   explaining a decision is a conversation both sides may want, and §8.1 gives rejection
 *   an "optional standard message".
 * - An **accepted** invitation. Not a sent one: §8.2 says acceptance "enables the
 *   corresponding communication flow", and being invited is not something the candidate
 *   agreed to.
 * - A **Candidate Unlock** (§6.6, BR-17). M12, and the odd one out: the other two are things
 *   the *candidate* did, and this is something the employer bought. There is no status to
 *   check because there is no way to undo it - BR-16 makes the pair permanent, and BR-24
 *   makes the debit behind it unrewritable. It is deliberately last, so an employer who
 *   already holds an application is never told they are relying on a purchase.
 *
 * **Precedence: application, then accepted invitation, then unlock.** For no deeper reason
 * than that each is a stronger claim than the next - the candidate initiated the first - and
 * all three routes serve identical bytes. "Do I hold an entitlement I paid for" is a
 * different question, and `GET /wallet/unlocks/:candidateUserId` is what answers it.
 *
 * The unlock is read from `candidate_unlocks` directly rather than through `WalletService`,
 * for the reason stated above: this file has no module dependencies, and three modules must
 * all be able to import it.
 */
@Injectable()
export class HiringInteractionService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async between(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<HiringInteraction | null> {
    const application = await this.db
      .selectFrom('applications')
      .innerJoin('vacancies', 'vacancies.id', 'applications.vacancy_id')
      .select('applications.id')
      .where('vacancies.employer_user_id', '=', employerUserId)
      .where('applications.candidate_user_id', '=', candidateUserId)
      .where('applications.status', '!=', 'withdrawn')
      .orderBy('applications.created_at', 'desc')
      .executeTakeFirst();

    if (application) {
      return { kind: 'applications', id: application.id };
    }

    const invitation = await this.db
      .selectFrom('invitations')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .where('status', '=', 'accepted')
      .orderBy('responded_at', 'desc')
      .executeTakeFirst();

    if (invitation) {
      return { kind: 'invitations', id: invitation.id };
    }

    // Last, and by the primary key: there is nothing to order by and no status to filter on,
    // because an unlock is one row that either exists or does not (BR-16).
    const unlock = await this.db
      .selectFrom('candidate_unlocks')
      .select('candidate_user_id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    return unlock ? { kind: 'unlocks', id: unlock.candidate_user_id } : null;
  }
}
