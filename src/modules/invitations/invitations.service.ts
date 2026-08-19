import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transaction, sql } from 'kysely';

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { DB, InvitationStatus, UserRole } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import {
  dayBoundsInZone,
  formatDateOnly,
  formatWithOffset,
} from '@infra/time/format';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { isOpenForApplications } from '@modules/vacancies/vacancy-status';

import { canRespond, isTerminal } from './invitation-status';

/** §8.2's daily send allowance, as the send screen needs it before offering the action. */
export interface InvitationQuota {
  remaining: number;
  /** The **effective** limit - free and, in future, purchased combined. */
  limit: number;
  /** When `remaining` returns to `limit`: the next midnight in the platform zone. */
  resetsAt: Date;
}

export interface InvitationInput {
  candidateUserId: string;
  /** An invitation to one of the employer's active vacancies... */
  vacancyId?: string;
  /** ...or a general one, which carries §8.2's five things itself. */
  occupationId?: string;
  regionId?: string;
  districtId?: string;
  salaryFrom?: number;
  salaryTo?: number;
  salaryPeriodId?: string;
  salaryIsNegotiable?: boolean;
  scheduleNote?: string;
  message?: string;
}

export interface Invitation {
  id: string;
  employerUserId: string;
  candidateUserId: string;
  /**
   * The candidate's name, so a sent list is readable.
   *
   * **A name is not protected data here**: §11.1 protects the phone number, e-mail and CV,
   * §7.3 puts the name on the search card the employer found this candidate through, and
   * §9.2 row 4 already names them in the notification the employer gets when they respond.
   * Withholding it on the list the employer *sent* would be inconsistent with all three.
   *
   * Null because `candidate_profiles.full_name` is nullable, and never because a rule
   * withheld it. It is not the BR-14 case: `invitations.candidate_user_id` references
   * `candidate_profiles.user_id` `ON DELETE CASCADE`, so an erased candidate's invitations
   * are deleted with their profile rather than left nameless.
   */
  candidateName: string | null;
  vacancyId: string | null;
  occupationId: string | null;
  regionId: string | null;
  districtId: string | null;
  salaryFrom: number | null;
  salaryTo: number | null;
  salaryPeriodId: string | null;
  salaryIsNegotiable: boolean;
  scheduleNote: string | null;
  message: string | null;
  status: InvitationStatus;
  responseNote: string | null;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InvitationRow {
  id: string;
  employer_user_id: string;
  candidate_user_id: string;
  candidate_name: string | null;
  vacancy_id: string | null;
  occupation_id: string | null;
  region_id: string | null;
  district_id: string | null;
  salary_from: string | null;
  salary_to: string | null;
  salary_period_id: string | null;
  salary_is_negotiable: boolean;
  schedule_note: string | null;
  message: string | null;
  status: InvitationStatus;
  response_note: string | null;
  responded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Direct employer invitations (§8.2), and BR-09's second interaction.
 *
 * The preconditions are the interesting part, because an invitation is the one thing in
 * this product that reaches *out* to a candidate:
 *
 * - **A verified employer only** (BR-03), the same gate as candidate search. An invitation
 *   from an unverified employer is a stranger's message with a job attached.
 * - **A search-visible candidate only** (§8.2). An employer cannot invite somebody they
 *   could not have found, which is BR-02's gate again - and it means hiding a profile
 *   stops invitations, not just search results.
 * - **An active vacancy only**, checked with M5's `isOpenForApplications`. Inviting
 *   somebody to a vacancy whose deadline has passed asks them to apply to something the
 *   apply route would refuse (BR-06), and one definition of "open" is what prevents that
 *   disagreement.
 *
 * Accepting an invitation is what makes the second half of BR-09 true, so
 * `acceptedInvitationWith` is read by the contact-exposure gatherer on every candidate
 * view and every file download.
 */
@Injectable()
export class InvitationsService {
  private readonly timeZone: string;
  private readonly dailyLimit: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly employers: EmployersService,
    private readonly dictionaries: DictionariesService,
    private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
    this.dailyLimit = config.get('EMPLOYER_DAILY_INVITATION_LIMIT', {
      infer: true,
    });
  }

  /**
   * §8.2's invitation, to a vacancy or general.
   *
   * `Idempotency-Key` for the reason ARCHITECTURE.md §7 names invitations explicitly:
   * the unique index refuses a duplicate but answers a retry with a conflict, which a
   * client cannot tell from "somebody else got there first"; the key makes an
   * interrupted-but-committed request replay as the success it was.
   */
  async invite(
    employerUserId: string,
    input: InvitationInput,
    idempotencyKey?: string,
  ): Promise<Invitation> {
    await this.employers.assertVerified(employerUserId);
    await this.assertShape(input);
    await this.assertInvitable(input.candidateUserId);

    if (input.vacancyId) {
      await this.assertVacancyOpen(employerUserId, input.vacancyId);
    }

    const id = await this.idempotency.run(
      idempotencyKey,
      employerUserId,
      'invitation.create',
      input,
      () => this.insert(employerUserId, input),
    );

    // §9.2 row 3: "New invitation or offer → Candidate".
    await this.notifications.notify({
      userId: input.candidateUserId,
      event: 'invitation_received',
      params: { employer: await this.employerName(employerUserId) },
      target: { type: 'invitation', id },
    });

    return this.byId(id);
  }

  /**
   * How many invitations this employer may still send today (§8.2).
   *
   * The send screen asks **before** offering the action, the way the unlock sheet shows the
   * cost and the balance before charging - a refusal after the tap is a worse version of the
   * same information.
   *
   * `limit` is the **effective** total, not a free allowance plus a purchased one. When extra
   * invitations become purchasable, this number grows and no client changes: the client
   * renders "12 of 30 left today" and has no opinion about where the 30 came from. Reporting
   * two tiers would make every client model a distinction only this service needs.
   */
  async quota(employerUserId: string): Promise<InvitationQuota> {
    const { start, end } = dayBoundsInZone(new Date(), this.timeZone);
    const used = await this.sentSince(this.db, employerUserId, start);

    return {
      remaining: Math.max(0, this.dailyLimit - used),
      limit: this.dailyLimit,
      resetsAt: end,
    };
  }

  /**
   * How many invitations this employer has sent since `since`.
   *
   * **A count of rows, not a stored counter**, and that decides three of §8.2's rules at once
   * rather than needing a policy for each:
   *
   * - *A sent invitation is never refunded.* There is no status filter here, so declining,
   *   expiring, or the vacancy closing cannot return the slot. The cost to the platform was
   *   the notification the candidate already received, and a decline does not un-send it.
   * - *Re-inviting after a decline counts.* It is a second row because it is a second
   *   notification to the same person.
   * - *An idempotent replay does not consume a slot.* `IdempotencyService.run` returns the
   *   recorded id **without calling `insert`**, so no row is written and there is nothing to
   *   count. That is the property the mobile team asked for, and it holds by construction
   *   rather than by remembering where to put a decrement - a stored counter would need the
   *   decrement placed correctly, and getting it wrong is invisible until an employer says the
   *   app ate their quota.
   */
  private async sentSince(
    db: Database | Transaction<DB>,
    employerUserId: string,
    since: Date,
  ): Promise<number> {
    const row = await db
      .selectFrom('invitations')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('employer_user_id', '=', employerUserId)
      .where('created_at', '>=', since)
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  /**
   * The insert and its BR-08 history row, in one transaction.
   *
   * The friendly "already invited" check is inside it, but the partial unique index is
   * what actually enforces the rule - a double-tap that gets past the check fails on the
   * constraint. Nothing throws after a write: the outcome is returned and the error
   * raised after the commit, which is the M1 trap MEMORY.md records.
   */
  private async insert(
    employerUserId: string,
    input: InvitationInput,
  ): Promise<string> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      // §8.2's daily cap, **inside the transaction and behind a row lock**. A count-then-insert
      // that is not serialized lets two sends at the boundary both read 29 and both write, so
      // the employer gets 31. There is no unique index that can express "at most 30 per day",
      // so this is one of the few rules the repository enforces with a lock rather than a
      // constraint - and the row locked is the employer's own, which serializes only their own
      // concurrent sends.
      await trx
        .selectFrom('employers')
        .select('user_id')
        .where('user_id', '=', employerUserId)
        .forUpdate()
        .executeTakeFirst();

      const { start, end } = dayBoundsInZone(new Date(), this.timeZone);
      const used = await this.sentSince(trx, employerUserId, start);

      if (used >= this.dailyLimit) {
        return {
          error: 'invitation.daily_limit_reached',
          resetsAt: end,
        } as const;
      }

      const open = await trx
        .selectFrom('invitations')
        .select('id')
        .where('employer_user_id', '=', employerUserId)
        .where('candidate_user_id', '=', input.candidateUserId)
        .where((eb) =>
          input.vacancyId
            ? eb('vacancy_id', '=', input.vacancyId)
            : eb('vacancy_id', 'is', null),
        )
        .where('status', 'in', ['sent', 'details_requested'])
        .executeTakeFirst();

      if (open) {
        return { error: 'invitation.already_invited' } as const;
      }

      const created = await trx
        .insertInto('invitations')
        .values({
          employer_user_id: employerUserId,
          candidate_user_id: input.candidateUserId,
          vacancy_id: input.vacancyId ?? null,
          occupation_id: input.occupationId ?? null,
          region_id: input.regionId ?? null,
          district_id: input.districtId ?? null,
          salary_from: input.salaryFrom ?? null,
          salary_to: input.salaryTo ?? null,
          salary_period_id: input.salaryPeriodId ?? null,
          salary_is_negotiable: input.salaryIsNegotiable ?? false,
          schedule_note: input.scheduleNote ?? null,
          message: input.message ?? null,
          status: 'sent',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('invitation_status_history')
        .values({
          invitation_id: created.id,
          from_status: null,
          to_status: 'sent',
          actor_user_id: employerUserId,
          actor_role: 'employer',
        })
        .execute();

      return { id: created.id } as const;
    });

    // Thrown after the transaction, never inside it: a throw from within rolls back the write
    // and leaves only the exception, which is the M1 trap MEMORY.md records twice.
    if ('error' in outcome) {
      if (outcome.error === 'invitation.daily_limit_reached') {
        throw new ConflictError(
          'invitation.daily_limit_reached',
          // Interpolated into the sentence the client renders...
          { limit: this.dailyLimit },
          // ...and repeated as machine-readable facts, so the screen can refresh its counter
          // without a second request or a regular expression over localized prose.
          {
            limit: this.dailyLimit,
            resetsAt: formatWithOffset(outcome.resetsAt, this.timeZone),
          },
        );
      }

      throw new ConflictError('invitation.already_invited');
    }

    return outcome.id;
  }

  /**
   * §8.2's Accept / Decline / Request details.
   *
   * One method rather than three routes' worth of logic, because the three differ only in
   * the status they set: the ownership check, the transition rule and the BR-08 history
   * row are identical, and splitting them is how one of the three ends up without the
   * audit row.
   */
  async respond(
    candidateUserId: string,
    invitationId: string,
    to: InvitationStatus,
    note: string | null,
  ): Promise<Invitation> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('invitations')
        .select(['id', 'status', 'candidate_user_id'])
        .where('id', '=', invitationId)
        .forUpdate()
        .executeTakeFirst();

      // 404 for somebody else's invitation: that one exists is not information we owe.
      if (!current || current.candidate_user_id !== candidateUserId) {
        return { error: 'invitation.not_found' } as const;
      }

      if (isTerminal(current.status)) {
        return { error: 'invitation.final' } as const;
      }

      if (!canRespond(current.status, to)) {
        return { error: 'invitation.response_not_allowed' } as const;
      }

      await trx
        .updateTable('invitations')
        .set({
          status: to,
          response_note: note,
          responded_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', invitationId)
        .execute();

      await trx
        .insertInto('invitation_status_history')
        .values({
          invitation_id: invitationId,
          from_status: current.status,
          to_status: to,
          actor_user_id: candidateUserId,
          actor_role: 'candidate',
          reason: note,
        })
        .execute();

      return { ok: true } as const;
    });

    if ('error' in outcome) {
      switch (outcome.error) {
        case 'invitation.not_found':
          throw new NotFoundError('invitation.not_found');
        case 'invitation.final':
          throw new ConflictError('invitation.final');
        default:
          throw new ConflictError('invitation.response_not_allowed');
      }
    }

    const invitation = await this.byId(invitationId);

    // §9.2 row 4: "Invitation response → Employer".
    await this.notifications.notify({
      userId: invitation.employerUserId,
      event: 'invitation_responded',
      params: { candidate: await this.candidateName(candidateUserId) },
      target: { type: 'invitation', id: invitationId },
    });

    return invitation;
  }

  /** The name a notification names them by - never a company's legal name (§6.1). */
  private async employerName(employerUserId: string): Promise<string> {
    const row = await this.db
      .selectFrom('employers')
      .leftJoin('companies', 'companies.employer_user_id', 'employers.user_id')
      .select(['employers.full_name', 'companies.public_name'])
      .where('employers.user_id', '=', employerUserId)
      .executeTakeFirst();

    return row?.public_name ?? row?.full_name ?? '';
  }

  private async candidateName(candidateUserId: string): Promise<string> {
    const row = await this.db
      .selectFrom('candidate_profiles')
      .select('full_name')
      .where('user_id', '=', candidateUserId)
      .executeTakeFirst();

    return row?.full_name ?? '';
  }

  /**
   * Every read of an invitation, with the candidate's name attached.
   *
   * One helper rather than the same `LEFT JOIN` written three times: the sent list, the
   * inbox and the single read must not be able to disagree about whether an invitation has
   * a name on it. `LEFT` because `full_name` is nullable, not because the row can be
   * missing - the foreign key cascades, so there is no invitation without a profile - and
   * every column is qualified because `candidate_profiles` also has a `created_at`, which
   * makes an unqualified `ORDER BY` here an ambiguous-column error rather than a wrong sort.
   */
  private readInvitations() {
    return this.db
      .selectFrom('invitations')
      .leftJoin(
        'candidate_profiles',
        'candidate_profiles.user_id',
        'invitations.candidate_user_id',
      )
      .selectAll('invitations')
      .select('candidate_profiles.full_name as candidate_name');
  }

  async byId(invitationId: string): Promise<Invitation> {
    const row = await this.readInvitations()
      .where('invitations.id', '=', invitationId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('invitation.not_found');
    }

    return toInvitation(row);
  }

  /**
   * One invitation, readable by either side of it and nobody else.
   *
   * The role decides *which* side to check, so it is asked for rather than inferred: a
   * user may hold both roles (§2.3), and "is this yours" has two different answers for
   * the same person. Anything that is not the candidate is checked as the employer, which
   * is what the route's role guard has already narrowed it to.
   */
  async forParticipant(
    userId: string,
    role: UserRole | null,
    invitationId: string,
  ): Promise<Invitation> {
    const invitation = await this.byId(invitationId);
    const isParticipant =
      role === 'candidate'
        ? invitation.candidateUserId === userId
        : invitation.employerUserId === userId;

    if (!isParticipant) {
      throw new NotFoundError('invitation.not_found');
    }

    return invitation;
  }

  /** The employer's sent invitations, optionally for one vacancy or one status. */
  async listSent(
    employerUserId: string,
    filters: { vacancyId?: string; status?: InvitationStatus } = {},
  ): Promise<Invitation[]> {
    await this.employers.assertVerified(employerUserId);

    let query = this.readInvitations().where(
      'invitations.employer_user_id',
      '=',
      employerUserId,
    );

    if (filters.vacancyId) {
      query = query.where('invitations.vacancy_id', '=', filters.vacancyId);
    }

    if (filters.status) {
      query = query.where('invitations.status', '=', filters.status);
    }

    const rows = await query
      .orderBy('invitations.created_at', 'desc')
      .execute();

    return rows.map(toInvitation);
  }

  /**
   * The candidate's inbox.
   *
   * Deliberately **not** filtered by the vacancy's visibility: an invitation to a vacancy
   * that has since closed still has to be readable, for the same reason a saved vacancy
   * does (§5.5) - a candidate needs to see what happened to something addressed to them,
   * not have it vanish.
   */
  async listReceived(candidateUserId: string): Promise<Invitation[]> {
    const rows = await this.readInvitations()
      .where('invitations.candidate_user_id', '=', candidateUserId)
      .orderBy('invitations.created_at', 'desc')
      .execute();

    return rows.map(toInvitation);
  }

  /** BR-08's trail for one invitation. */
  async history(invitationId: string): Promise<
    {
      fromStatus: InvitationStatus | null;
      toStatus: InvitationStatus;
      actorRole: UserRole | null;
      reason: string | null;
      createdAt: Date;
    }[]
  > {
    const rows = await this.db
      .selectFrom('invitation_status_history')
      .select([
        'from_status',
        'to_status',
        'actor_role',
        'reason',
        'created_at',
      ])
      .where('invitation_id', '=', invitationId)
      .orderBy('created_at')
      .execute();

    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorRole: row.actor_role,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /**
   * §7.4's counters: invited, accepted and declined against one vacancy.
   *
   * "Track invited, accepted, interviewed and hired counts against the target of 20" -
   * the last two are application stages and come from `/vacancies/{id}/applications/
   * counts`; these are the two only invitations know about.
   */
  async countsForVacancy(
    employerUserId: string,
    vacancyId: string,
  ): Promise<Record<string, number>> {
    await this.employers.assertVerified(employerUserId);
    await this.assertVacancyOwned(employerUserId, vacancyId);

    const rows = await this.db
      .selectFrom('invitations')
      .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
      .where('employer_user_id', '=', employerUserId)
      .where('vacancy_id', '=', vacancyId)
      .groupBy('status')
      .execute();

    const counts: Record<string, number> = {};

    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }

    return counts;
  }

  /**
   * BR-09's second interaction: this employer invited the candidate and they accepted.
   *
   * The id rather than a boolean, because the entitlement it grants is served by a route
   * scoped to it - `/invitations/{id}/files/{fileId}/content`, the invitation's equivalent
   * of the application-scoped download.
   */
  async acceptedInvitationWith(
    employerUserId: string,
    candidateUserId: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom('invitations')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .where('status', '=', 'accepted')
      .orderBy('responded_at', 'desc')
      .executeTakeFirst();

    return row?.id ?? null;
  }

  /**
   * Exactly one of §8.2's two shapes, and valid dictionary ids for the general one.
   *
   * The CHECK constraint refuses the wrong shape too - this exists so the answer is a
   * message rather than a constraint error, and because an employer who sent neither a
   * vacancy nor an occupation has made a mistake worth naming.
   */
  private async assertShape(input: InvitationInput): Promise<void> {
    if (Boolean(input.vacancyId) === Boolean(input.occupationId)) {
      throw new BadRequestError('invitation.shape_invalid');
    }

    // Only the general shape carries ids of its own; a vacancy invitation reads them from
    // the vacancy, which validated them when it was written.
    const expected: [string | undefined, string][] = [
      [input.occupationId, 'occupation'],
      [input.regionId, 'region'],
      [input.districtId, 'region'],
      [input.salaryPeriodId, 'payment_period'],
    ];
    const ids = expected
      .map(([id]) => id)
      .filter((id): id is string => id !== undefined);

    if (ids.length === 0) {
      return;
    }

    const facts = await this.dictionaries.lookupForValidation(ids);

    for (const [id, typeCode] of expected) {
      if (!id) {
        continue;
      }

      const item = facts.get(id);

      // The foreign key only proves it is *a* dictionary item; a skill id in the
      // occupation field would pass that and mean nothing.
      if (!item || !item.isActive || item.typeCode !== typeCode) {
        throw new BadRequestError('invitation.dictionary_item_invalid');
      }
    }
  }

  /**
   * §8.2's "search-visible candidate" - BR-02's gate, applied to who may be invited.
   *
   * The same check `CandidateSearchService.assertFindable` makes, deliberately duplicated
   * once rather than shared through a module dependency in the wrong direction: an
   * invitation is not part of search, and a third copy is the point at which this should
   * move to the candidates module.
   */
  private async assertInvitable(candidateUserId: string): Promise<void> {
    const row = await this.db
      .selectFrom('candidate_profiles')
      .select('user_id')
      .where('user_id', '=', candidateUserId)
      .where('visibility', '=', 'searchable')
      .where('is_complete', '=', true)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('candidate.profile_not_found');
    }
  }

  private async assertVacancyOpen(
    employerUserId: string,
    vacancyId: string,
  ): Promise<void> {
    const vacancy = await this.assertVacancyOwned(employerUserId, vacancyId);
    const today = formatDateOnly(new Date(), this.timeZone);

    // M5's one definition of "open", so an invitation cannot advertise a vacancy the
    // apply route would refuse (BR-06).
    if (!isOpenForApplications(vacancy.status, vacancy.deadline_on, today)) {
      throw new ConflictError('invitation.vacancy_not_open');
    }
  }

  private async assertVacancyOwned(employerUserId: string, vacancyId: string) {
    const row = await this.db
      .selectFrom('vacancies')
      .select(['id', 'status', 'deadline_on'])
      .where('id', '=', vacancyId)
      .where('employer_user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('vacancy.not_found');
    }

    return row;
  }
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    employerUserId: row.employer_user_id,
    candidateUserId: row.candidate_user_id,
    candidateName: row.candidate_name,
    vacancyId: row.vacancy_id,
    occupationId: row.occupation_id,
    regionId: row.region_id,
    districtId: row.district_id,
    salaryFrom: row.salary_from === null ? null : Number(row.salary_from),
    salaryTo: row.salary_to === null ? null : Number(row.salary_to),
    salaryPeriodId: row.salary_period_id,
    salaryIsNegotiable: row.salary_is_negotiable,
    scheduleNote: row.schedule_note,
    message: row.message,
    status: row.status,
    responseNote: row.response_note,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
