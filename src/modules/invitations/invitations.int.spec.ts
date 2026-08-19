import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { formatWithOffset } from '@infra/time/format';
import { CandidateViewService } from '@modules/applications/candidate-view.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';

import { InvitationsService } from './invitations.service';

/**
 * Invitations against a real Postgres (§8.2).
 *
 * The two rules that cannot be unit-tested are the reason this file exists: "one open
 * invitation per employer, candidate and vacancy" is a partial unique index with
 * `NULLS NOT DISTINCT`, and the test that matters fires two invitations concurrently to
 * prove the database wins that race. BR-08's history row is written in the same
 * transaction as the status change, and BR-09's second interaction is a query against
 * these rows.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let candidates: CandidatesService;
let vacancies: VacanciesService;
let invitations: InvitationsService;
let candidateView: CandidateViewService;
/** Module-scoped so the quota tests can build a second service with a smaller cap. */
let dictionaries: DictionariesService;

/**
 * The real notifications service over a no-op sender.
 *
 * Real rather than stubbed, so every one of these suites also exercises the notification
 * write M9 added to the flow it covers; no-op sender, so nothing reaches FCM.
 */
let notifications: NotificationsService;

const users: string[] = [];

const ENV: Record<string, string | number | boolean> = {
  PLATFORM_TIME_ZONE: 'Asia/Tashkent',
  MODERATION_ENABLED: false,
  EMPLOYER_VERIFICATION_ENABLED: false,
  FILE_MAX_SIZE_BYTES: 10_485_760,
  SEARCH_COUNT_CAP: 200,
  // §8.2's production default. The cap tests build their own service with a smaller one, so
  // that reaching the limit costs three candidates rather than thirty-one.
  EMPLOYER_DAILY_INVITATION_LIMIT: 30,
};

const config = {
  get: (key: string) => ENV[key],
} as unknown as ConfigService<AppEnv, true>;

/** Files are stubbed: what these tests cover is who may read, not Telegram. */
const filesStub = {
  readAsAuthorized: (ownerUserId: string, fileId: string) =>
    Promise.resolve({
      file: {
        id: fileId,
        purposeId: 'p',
        fileName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        createdAt: new Date(),
      },
      bytes: Buffer.from(ownerUserId.slice(0, 3)),
    }),
} as never;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());

  notifications = new NotificationsService(
    db,
    new PushDispatcher(db, new NoopPushSender()),
  );

  dictionaries = new DictionariesService(db);
  const schemas = new SchemasService(db, dictionaries, config);
  const validator = new FieldValidatorService(dictionaries, config);

  employers = new EmployersService(db);
  candidates = new CandidatesService(db, schemas, validator);
  vacancies = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    notifications,
    config,
  );
  invitations = new InvitationsService(
    db,
    employers,
    dictionaries,
    new IdempotencyService(db),
    notifications,
    config,
  );
  candidateView = new CandidateViewService(
    db,
    employers,
    new HiringInteractionService(db),
    filesStub,
  );
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('employers').where('user_id', '=', id).execute();
    await db
      .deleteFrom('stored_files')
      .where('owner_user_id', '=', id)
      .execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function seededId(type: string, code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function anyActive(type: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function region(): Promise<{ regionId: string; districtId: string }> {
  const parent = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'region')
    .where('parent_id', 'is', null)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  const child = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('parent_id', '=', parent.id)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return { regionId: parent.id, districtId: child.id };
}

async function newUser(role: 'candidate' | 'employer'): Promise<string> {
  const phone = `+99899${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
}

async function newEmployer(verified = true): Promise<string> {
  const employerUserId = await newUser('employer');
  const { regionId } = await region();

  await employers.upsert(employerUserId, 'company', {
    contactPhone: '+998901234567',
    regionId,
    legalName: 'Uzum Market LLC',
    publicName: 'Uzum',
    industryId: await anyActive('industry'),
    contactPersonName: 'Anvar Karimov',
    description: 'Marketplace operator hiring call-centre staff.',
  });

  if (verified) {
    await new VerificationService(db, employers, notifications, config).submit(
      employerUserId,
      [await evidenceFile(employerUserId)],
    );
  }

  return employerUserId;
}

async function evidenceFile(ownerUserId: string): Promise<string> {
  const unique = randomUUID();
  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: await seededId('file_purpose', 'company_registration'),
      telegram_file_id: `fake-${unique}`,
      telegram_file_unique_id: unique,
      telegram_message_id: '1',
      file_name: 'registration.pdf',
      mime_type: 'application/pdf',
      size_bytes: 128,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

async function newCandidate(
  visibility: 'searchable' | 'hidden' = 'searchable',
): Promise<string> {
  const userId = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(userId, {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'call_centre_operator'),
  });
  await candidates.setVisibility(userId, visibility);

  return userId;
}

async function publishedVacancy(
  employerUserId: string,
  options: { deadlineOn?: string } = {},
): Promise<string> {
  const { regionId, districtId } = await region();
  const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;

  await vacancies.patch(employerUserId, vacancyId, {
    occupation_id: await seededId('occupation', 'call_centre_operator'),
    title: 'Call-centre operator',
    description: 'Answer customer calls in Russian and Uzbek, politely.',
    worker_count: 20,
    region_id: regionId,
    district_id: districtId,
    employment_type_ids: [await seededId('employment_type', 'full_time')],
    salary: {
      from: 4_000_000,
      to: 6_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
    ...(options.deadlineOn ? { deadline_on: options.deadlineOn } : {}),
  });
  await vacancies.submit(employerUserId, vacancyId);

  return vacancyId;
}

/** A general invitation's own §8.2 content. */
async function generalInput(candidateUserId: string) {
  const { regionId, districtId } = await region();

  return {
    candidateUserId,
    occupationId: await seededId('occupation', 'call_centre_operator'),
    regionId,
    districtId,
    salaryFrom: 4_000_000,
    salaryTo: 6_000_000,
    salaryPeriodId: await seededId('payment_period', 'monthly'),
    scheduleNote: 'Five days a week, 09:00 to 18:00.',
    message: 'We are hiring twenty operators; call Anvar on the number above.',
  };
}

describe('sending an invitation (§8.2, BR-03)', () => {
  it('invites a candidate to a vacancy, with its BR-08 history row', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);

    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'Your profile fits our Russian-language queue.',
    });

    expect(invitation.status).toBe('sent');
    expect(invitation.vacancyId).toBe(vacancyId);
    expect(invitation.respondedAt).toBeNull();
    expect(await invitations.history(invitation.id)).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'sent',
        actorRole: 'employer',
      }),
    ]);
  });

  it('sends a general invitation carrying its own occupation, place and pay', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    const invitation = await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );

    expect(invitation.vacancyId).toBeNull();
    expect(invitation.occupationId).not.toBeNull();
    expect(invitation.salaryTo).toBe(6_000_000);
    expect(invitation.scheduleNote).toContain('09:00');
  });

  it('refuses an invitation that is neither shape, and one that is both', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);

    await expect(
      invitations.invite(employerUserId, { candidateUserId }),
    ).rejects.toThrow(BadRequestError);

    await expect(
      invitations.invite(employerUserId, {
        candidateUserId,
        vacancyId,
        occupationId: await seededId('occupation', 'call_centre_operator'),
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('refuses a dictionary id of the wrong type', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    // The foreign key only proves it is *a* dictionary item; a skill in the occupation
    // field would pass that and mean nothing.
    await expect(
      invitations.invite(employerUserId, {
        candidateUserId,
        occupationId: await seededId('skill', 'crm_work'),
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('refuses an unverified employer (BR-03)', async () => {
    const employerUserId = await newEmployer(false);
    const candidateUserId = await newCandidate();

    // M4 left this test to be written with the route it guards: an invitation from an
    // unverified employer is a stranger's message with a job attached.
    await expect(
      invitations.invite(employerUserId, await generalInput(candidateUserId)),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses to invite a candidate who is not search-visible (§8.2)', async () => {
    const employerUserId = await newEmployer();
    const hidden = await newCandidate('hidden');

    await expect(
      invitations.invite(employerUserId, await generalInput(hidden)),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses another employer’s vacancy, and one whose deadline has passed (BR-06)', async () => {
    const employerUserId = await newEmployer();
    const stranger = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const expired = await publishedVacancy(employerUserId, {
      deadlineOn: '2099-01-01',
    });

    // The deadline is moved into the past directly, because M5 refuses to *submit* a
    // vacancy that is already expired - only the passage of time produces this state, and
    // that is the state BR-06 is about.
    await db
      .updateTable('vacancies')
      .set({ deadline_on: '2020-01-01' })
      .where('id', '=', expired)
      .execute();

    await expect(
      invitations.invite(stranger, { candidateUserId, vacancyId }),
    ).rejects.toThrow(NotFoundError);

    // Inviting somebody to a vacancy the apply route would refuse is the disagreement
    // one definition of "open" prevents.
    await expect(
      invitations.invite(employerUserId, {
        candidateUserId,
        vacancyId: expired,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a paused vacancy', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    await vacancies.changeStatus(employerUserId, vacancyId, 'paused', null);

    await expect(
      invitations.invite(employerUserId, { candidateUserId, vacancyId }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('one open invitation at a time', () => {
  it('refuses a second open invitation to the same vacancy', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    await invitations.invite(employerUserId, { candidateUserId, vacancyId });

    await expect(
      invitations.invite(employerUserId, { candidateUserId, vacancyId }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a second open *general* invitation, which needs NULLS NOT DISTINCT', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const input = await generalInput(candidateUserId);
    await invitations.invite(employerUserId, input);

    // Two null `vacancy_id` values would count as different without the index's
    // `NULLS NOT DISTINCT`, and an employer could spam general invitations.
    await expect(invitations.invite(employerUserId, input)).rejects.toThrow(
      ConflictError,
    );
  });

  it('produces exactly one invitation from a concurrent double-tap', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);

    const results = await Promise.allSettled([
      invitations.invite(employerUserId, { candidateUserId, vacancyId }),
      invitations.invite(employerUserId, { candidateUserId, vacancyId }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const rows = await db
      .selectFrom('invitations')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('lets an employer invite again after a decline, and not before', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const first = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
    });

    await expect(
      invitations.invite(employerUserId, { candidateUserId, vacancyId }),
    ).rejects.toThrow(ConflictError);

    await invitations.respond(candidateUserId, first.id, 'declined', null);
    const second = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
    });

    expect(second.id).not.toBe(first.id);
  });

  it('replays an interrupted invitation under the same idempotency key', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const key = randomUUID();

    const first = await invitations.invite(
      employerUserId,
      { candidateUserId, vacancyId },
      key,
    );
    const replay = await invitations.invite(
      employerUserId,
      { candidateUserId, vacancyId },
      key,
    );

    // A lost response is what the key exists for: the retry is the success it was, not a
    // conflict the client cannot interpret.
    expect(replay.id).toBe(first.id);

    // A different request under the same key is the client's bug.
    await expect(
      invitations.invite(
        employerUserId,
        { candidateUserId, vacancyId, message: 'different' },
        key,
      ),
    ).rejects.toThrow(ConflictError);
  });
});

describe('the candidate’s response (§8.2)', () => {
  async function invited(): Promise<{
    employerUserId: string;
    candidateUserId: string;
    invitationId: string;
  }> {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
    });

    return { employerUserId, candidateUserId, invitationId: invitation.id };
  }

  it('accepts, stamping the response time and writing the history row', async () => {
    const { candidateUserId, invitationId } = await invited();

    const accepted = await invitations.respond(
      candidateUserId,
      invitationId,
      'accepted',
      'Happy to start next week.',
    );

    expect(accepted.status).toBe('accepted');
    expect(accepted.respondedAt).not.toBeNull();
    expect(accepted.responseNote).toContain('next week');
    expect(await invitations.history(invitationId)).toEqual([
      expect.objectContaining({ toStatus: 'sent', actorRole: 'employer' }),
      expect.objectContaining({
        fromStatus: 'sent',
        toStatus: 'accepted',
        actorRole: 'candidate',
        reason: 'Happy to start next week.',
      }),
    ]);
  });

  it('asks for details and then accepts, keeping all three history rows', async () => {
    const { candidateUserId, invitationId } = await invited();

    await invitations.respond(
      candidateUserId,
      invitationId,
      'details_requested',
      'Is transport provided?',
    );
    const accepted = await invitations.respond(
      candidateUserId,
      invitationId,
      'accepted',
      null,
    );

    expect(accepted.status).toBe('accepted');
    expect(await invitations.history(invitationId)).toHaveLength(3);
  });

  it('refuses a second request for details', async () => {
    const { candidateUserId, invitationId } = await invited();
    await invitations.respond(
      candidateUserId,
      invitationId,
      'details_requested',
      'When does it start?',
    );

    await expect(
      invitations.respond(
        candidateUserId,
        invitationId,
        'details_requested',
        'And the pay?',
      ),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses to answer an invitation twice', async () => {
    const { candidateUserId, invitationId } = await invited();
    await invitations.respond(candidateUserId, invitationId, 'declined', null);

    await expect(
      invitations.respond(candidateUserId, invitationId, 'accepted', null),
    ).rejects.toThrow(ConflictError);
  });

  it('never lets one candidate answer another’s invitation', async () => {
    const { invitationId } = await invited();
    const stranger = await newCandidate();

    await expect(
      invitations.respond(stranger, invitationId, 'accepted', null),
    ).rejects.toThrow(NotFoundError);
  });

  it('shows the invitation to both sides and to nobody else', async () => {
    const { employerUserId, candidateUserId, invitationId } = await invited();
    const stranger = await newEmployer();

    await expect(
      invitations.forParticipant(candidateUserId, 'candidate', invitationId),
    ).resolves.toMatchObject({ id: invitationId });
    await expect(
      invitations.forParticipant(employerUserId, 'employer', invitationId),
    ).resolves.toMatchObject({ id: invitationId });
    await expect(
      invitations.forParticipant(stranger, 'employer', invitationId),
    ).rejects.toThrow(NotFoundError);
  });

  it('lists the invitation on both sides, and counts it for the vacancy (§7.4)', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
    });
    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    expect(
      (await invitations.listSent(employerUserId, { vacancyId })).map(
        (item) => item.id,
      ),
    ).toEqual([invitation.id]);
    expect(
      (await invitations.listReceived(candidateUserId)).map((item) => item.id),
    ).toEqual([invitation.id]);
    expect(
      await invitations.countsForVacancy(employerUserId, vacancyId),
    ).toEqual({ accepted: 1 });
  });

  it('keeps an invitation readable after its vacancy closes', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    await invitations.invite(employerUserId, { candidateUserId, vacancyId });

    await vacancies.changeStatus(employerUserId, vacancyId, 'closed', 'filled');

    // A candidate needs to see what became of something addressed to them, which is why
    // the inbox is not filtered by the vacancy's visibility.
    expect(await invitations.listReceived(candidateUserId)).toHaveLength(1);
  });
});

describe('BR-09’s second interaction', () => {
  it('reveals nothing while the invitation is only sent', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    // Inviting somebody is not an interaction they agreed to. Until they accept, this is
    // the same answer a stranger gets.
    expect(view.phone).toBeNull();
    expect(view.canViewFiles).toBe(false);
    expect(view.exposureReason).toBe('unlock_required');
  });

  it('reveals contact details and files once the candidate accepts', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const invitation = await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );

    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);
    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    expect(view.phone).not.toBeNull();
    expect(view.canViewFiles).toBe(true);
    expect(view.exposureReason).toBe('accepted_invitation');
  });

  it('reveals nothing when the candidate declines', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const invitation = await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );

    await invitations.respond(candidateUserId, invitation.id, 'declined', null);

    await expect(
      candidateView.forCandidate(employerUserId, candidateUserId),
    ).resolves.toMatchObject({
      phone: null,
      exposureReason: 'unlock_required',
    });
  });

  it('scopes the download path to the invitation that granted it', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const fileId = await candidateFile(candidateUserId);
    const invitation = await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );
    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    // The entitlement comes from the invitation, so the route that serves the bytes is the
    // one that can see it - never `/files/{id}/content`, which stays owner-only.
    expect(view.files).toEqual([
      expect.objectContaining({
        id: fileId,
        downloadPath: `/invitations/${invitation.id}/files/${fileId}/content`,
      }),
    ]);
    await expect(
      candidateView.downloadForInvitation(
        employerUserId,
        invitation.id,
        fileId,
      ),
    ).resolves.toMatchObject({ file: { id: fileId } });
  });

  it('refuses the download while the invitation is unanswered, and for another employer', async () => {
    const employerUserId = await newEmployer();
    const stranger = await newEmployer();
    const candidateUserId = await newCandidate();
    const fileId = await candidateFile(candidateUserId);
    const invitation = await invitations.invite(
      employerUserId,
      await generalInput(candidateUserId),
    );

    await expect(
      candidateView.downloadForInvitation(
        employerUserId,
        invitation.id,
        fileId,
      ),
    ).rejects.toThrow(NotFoundError);

    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    // BR-09 is re-evaluated per download, so holding a path is not holding permission.
    await expect(
      candidateView.downloadForInvitation(stranger, invitation.id, fileId),
    ).rejects.toThrow(NotFoundError);
  });
});

async function candidateFile(ownerUserId: string): Promise<string> {
  const unique = randomUUID();
  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: await seededId('file_purpose', 'cv'),
      telegram_file_id: `fake-${unique}`,
      telegram_file_unique_id: unique,
      telegram_message_id: '3',
      file_name: 'cv.pdf',
      mime_type: 'application/pdf',
      size_bytes: 256,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/**
 * Â§8.2's daily invitation cap.
 *
 * Sending is free (Â§7.3 lists it beside "View profile" and "Save", and Â§7.4's own example
 * fills twenty openings by inviting people), so a volume cap is what stands in for a price.
 * BR-03's verification is an admission gate, not a rate limit.
 *
 * These use a service with a **limit of three** rather than the configured thirty, so
 * reaching the cap costs four candidates instead of thirty-one. The number under test is the
 * rule, not the default.
 */
describe('the daily invitation quota (Â§8.2)', () => {
  /** The same service with a smaller cap. Everything else is the production wiring. */
  function limitedTo(limit: number): InvitationsService {
    return new InvitationsService(
      db,
      employers,
      dictionaries,
      new IdempotencyService(db),
      notifications,
      {
        get: (key: string) =>
          key === 'EMPLOYER_DAILY_INVITATION_LIMIT' ? limit : ENV[key],
      } as unknown as ConfigService<AppEnv, true>,
    );
  }

  it('starts full, and reports the next platform-zone midnight', async () => {
    const employerUserId = await newEmployer();
    const quota = await invitations.quota(employerUserId);

    expect(quota).toMatchObject({ remaining: 30, limit: 30 });

    // The boundary is Tashkent midnight, which is 19:00 UTC - and this assertion is the reason
    // the test exists: every machine on this project sits at UTC+5, so a counter keyed on the
    // UTC date is indistinguishable from a correct one in local development for nineteen hours
    // out of twenty-four.
    expect(quota.resetsAt.getUTCHours()).toBe(19);
    expect(formatWithOffset(quota.resetsAt, 'Asia/Tashkent')).toMatch(
      /T00:00:00\+05:00$/,
    );
    expect(quota.resetsAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('counts down as invitations are sent', async () => {
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);

    await invitations.invite(employerUserId, {
      candidateUserId: await newCandidate(),
      vacancyId,
      message: 'First.',
    });

    expect((await invitations.quota(employerUserId)).remaining).toBe(29);
  });

  it('allows the last one and refuses the next, with the figures to render it', async () => {
    const capped = limitedTo(3);
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);

    for (let sent = 0; sent < 3; sent += 1) {
      await capped.invite(employerUserId, {
        candidateUserId: await newCandidate(),
        vacancyId,
        message: `Invitation ${sent + 1}.`,
      });
    }

    expect(await capped.quota(employerUserId)).toMatchObject({
      remaining: 0,
      limit: 3,
    });

    // 409 rather than 429: this is a business rule with a known reset time, not "you are going
    // too fast". A 429 invites interceptors and proxies to retry it.
    await expect(
      capped.invite(employerUserId, {
        candidateUserId: await newCandidate(),
        vacancyId,
        message: 'One too many.',
      }),
    ).rejects.toMatchObject({
      messageKey: 'invitation.daily_limit_reached',
      // The structured half: the screen refreshes its counter without a second request and
      // without a regular expression over localized prose.
      details: {
        limit: 3,
        resetsAt: expect.stringMatching(/T00:00:00\+05:00$/),
      },
    });
  });

  it('does not consume a slot when an idempotent send is replayed', async () => {
    // **The failure a user experiences as "the app ate my quota".** The client persists an
    // `Idempotency-Key` before the request and clears it only on an answer, precisely so a
    // dropped response replays rather than duplicates. If the replay consumed a slot, a flaky
    // connection would quietly bill an employer for invitations nobody received.
    //
    // It holds by construction rather than by placing a decrement carefully: the quota is a
    // count of rows, and `IdempotencyService.run` returns the recorded id without calling the
    // insert at all - so there is no second row to count.
    const capped = limitedTo(3);
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);
    const candidateUserId = await newCandidate();
    const key = randomUUID();

    const first = await capped.invite(
      employerUserId,
      { candidateUserId, vacancyId, message: 'Sent once.' },
      key,
    );

    expect((await capped.quota(employerUserId)).remaining).toBe(2);

    const replay = await capped.invite(
      employerUserId,
      { candidateUserId, vacancyId, message: 'Sent once.' },
      key,
    );

    expect(replay.id).toBe(first.id);
    expect((await capped.quota(employerUserId)).remaining).toBe(2);
  });

  it('does not return the slot when the candidate declines', async () => {
    // Â§8.2: the cost to the platform is the notification the candidate already received, and a
    // decline does not un-send it. The quota counts rows with no status filter, so this is a
    // property of the query rather than a rule somebody has to remember not to break.
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);
    const candidateUserId = await newCandidate();

    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'Please consider us.',
    });

    expect((await invitations.quota(employerUserId)).remaining).toBe(29);

    await invitations.respond(candidateUserId, invitation.id, 'declined', null);

    expect((await invitations.quota(employerUserId)).remaining).toBe(29);
  });

  it('counts a re-invitation after a decline as a second send', async () => {
    // The one case the mobile team flagged as arguable. It counts: a second row is a second
    // notification to the same person, and the platform paid for both.
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);
    const candidateUserId = await newCandidate();

    const first = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'First ask.',
    });
    await invitations.respond(candidateUserId, first.id, 'declined', null);
    await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'Asking again.',
    });

    expect((await invitations.quota(employerUserId)).remaining).toBe(28);
  });

  it('ignores invitations sent before today', async () => {
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);

    // Dated by a raw insert, the way UAT-15 ages a vacancy deadline: the write path stamps
    // `created_at` itself, and the alternative is a test that waits until tomorrow.
    await db
      .insertInto('invitations')
      .values({
        employer_user_id: employerUserId,
        candidate_user_id: await newCandidate(),
        vacancy_id: vacancyId,
        status: 'sent',
        created_at: sql`now() - interval '2 days'`,
      })
      .execute();

    expect((await invitations.quota(employerUserId)).remaining).toBe(30);
  });

  it('refuses at the cap even when two sends race', async () => {
    // There is no unique index that can say "at most three per day", so the rule is a count
    // inside the transaction behind a lock on the employer's own row. Without the lock both
    // transactions read two and both write, and the employer gets four.
    const capped = limitedTo(3);
    const employerUserId = await newEmployer();
    const vacancyId = await publishedVacancy(employerUserId);

    for (let sent = 0; sent < 2; sent += 1) {
      await capped.invite(employerUserId, {
        candidateUserId: await newCandidate(),
        vacancyId,
        message: `Warm-up ${sent + 1}.`,
      });
    }

    const results = await Promise.allSettled([
      capped.invite(employerUserId, {
        candidateUserId: await newCandidate(),
        vacancyId,
        message: 'Racer one.',
      }),
      capped.invite(employerUserId, {
        candidateUserId: await newCandidate(),
        vacancyId,
        message: 'Racer two.',
      }),
    ]);

    // One of the two may lose, but the total must never exceed the cap.
    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(1);
    expect((await capped.quota(employerUserId)).remaining).toBe(0);
  });
});
