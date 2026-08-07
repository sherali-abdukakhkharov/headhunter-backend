import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

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

/**
 * The real notifications service over a no-op sender.
 *
 * Real rather than stubbed, so every one of these suites also exercises the notification
 * write M9 added to the flow it covers; no-op sender, so nothing reaches FCM.
 */
let notifications: NotificationsService;

const users: string[] = [];

const config = {
  get: (key: string) =>
    key === 'PLATFORM_TIME_ZONE'
      ? 'Asia/Tashkent'
      : key === 'MODERATION_ENABLED' || key === 'EMPLOYER_VERIFICATION_ENABLED'
        ? false
        : key === 'FILE_MAX_SIZE_BYTES'
          ? 10_485_760
          : key === 'SEARCH_COUNT_CAP'
            ? 200
            : undefined,
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

  const dictionaries = new DictionariesService(db);
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
    expect(view.exposureReason).toBe('no_interaction');
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
      exposureReason: 'no_interaction',
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
