import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ConflictError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { ApplicationsService } from '@modules/applications/applications.service';
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

import { InterviewsService } from './interviews.service';

/**
 * Interview scheduling against a real Postgres (§8.3).
 *
 * Two things here can only be checked against a database. §8.3's conditional requirement
 * is a CHECK constraint as well as a rule, and the two must agree - `interview-rules.spec`
 * pins the rule, and these tests prove the constraint refuses the same shapes. And
 * scheduling moves the application to §8.1's `interview` stage **in the same
 * transaction**, which is a claim about atomicity that only a transaction can test.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let candidates: CandidatesService;
let vacancies: VacanciesService;
let applications: ApplicationsService;
let interviews: InterviewsService;

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
          : undefined,
} as unknown as ConfigService<AppEnv, true>;

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
  applications = new ApplicationsService(
    db,
    new IdempotencyService(db),
    notifications,
    config,
  );
  interviews = new InterviewsService(db, applications, notifications);
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
  const phone = `+99894${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
}

async function newEmployer(): Promise<string> {
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

  const unique = randomUUID();
  const file = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: employerUserId,
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
  await new VerificationService(db, employers, notifications, config).submit(
    employerUserId,
    [file.id],
  );

  return employerUserId;
}

async function newCandidate(): Promise<string> {
  const userId = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(userId, {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'call_centre_operator'),
  });
  await candidates.setVisibility(userId, 'searchable');

  return userId;
}

/** An employer, a candidate and the application §8.3 hangs an interview off. */
async function applied(): Promise<{
  employerUserId: string;
  candidateUserId: string;
  applicationId: string;
}> {
  const employerUserId = await newEmployer();
  const candidateUserId = await newCandidate();
  const { regionId, districtId } = await region();
  const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;

  await vacancies.patch(employerUserId, vacancyId, {
    occupation_id: await seededId('occupation', 'call_centre_operator'),
    title: 'Call-centre operator',
    description: 'Answer customer calls in Russian and Uzbek, politely.',
    worker_count: 3,
    region_id: regionId,
    district_id: districtId,
    employment_type_ids: [await seededId('employment_type', 'full_time')],
    salary: {
      from: 4_000_000,
      to: 6_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
  });
  await vacancies.submit(employerUserId, vacancyId);

  const application = await applications.apply(
    candidateUserId,
    vacancyId,
    null,
  );

  return { employerUserId, candidateUserId, applicationId: application.id };
}

const AT = new Date('2026-08-20T09:00:00.000Z');

describe('scheduling (§8.3)', () => {
  it('schedules a phone interview and moves the application to the interview stage', async () => {
    const { employerUserId, applicationId } = await applied();

    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
      instructions: 'Bring your ID number.',
    });

    expect(interview.status).toBe('scheduled');
    expect(interview.respondedAt).toBeNull();

    // §8.1's stage table says the candidate is told date, time, type and location when
    // the stage is set - so the stage and the interview are one event.
    expect((await applications.byId(applicationId)).status).toBe('interview');
    expect(await applications.history(applicationId)).toEqual([
      expect.objectContaining({ toStatus: 'submitted' }),
      expect.objectContaining({
        fromStatus: 'submitted',
        toStatus: 'interview',
        actorRole: 'employer',
      }),
    ]);
    expect(await interviews.history(interview.id)).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'scheduled' }),
    ]);
  });

  it('leaves an application that is already past the interview stage alone', async () => {
    const { employerUserId, applicationId } = await applied();
    await applications.moveStage(employerUserId, applicationId, 'offer', null);

    await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });

    // Not a backwards move to refuse - a stage that has already passed this one.
    expect((await applications.byId(applicationId)).status).toBe('offer');
  });

  it('refuses to schedule against a rejected application, and writes nothing', async () => {
    const { employerUserId, applicationId } = await applied();
    await applications.moveStage(
      employerUserId,
      applicationId,
      'rejected',
      'Not this time.',
    );

    await expect(
      interviews.schedule(employerUserId, applicationId, {
        type: 'phone',
        scheduledAt: AT,
      }),
    ).rejects.toThrow(ConflictError);

    const rows = await db
      .selectFrom('interviews')
      .select('id')
      .where('application_id', '=', applicationId)
      .execute();

    // The throw happens before the transaction writes anything, which is the ordering
    // MEMORY.md's M1 trap is about.
    expect(rows).toEqual([]);
  });

  it('refuses another employer’s application', async () => {
    const { applicationId } = await applied();
    const stranger = await newEmployer();

    await expect(
      interviews.schedule(stranger, applicationId, {
        type: 'phone',
        scheduledAt: AT,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it.each([
    ['in_person with no address', { type: 'in_person' as const }],
    ['external_link with no link', { type: 'external_link' as const }],
    [
      'phone carrying an address',
      { type: 'phone' as const, location: 'Amir Temur 1' },
    ],
  ])('refuses %s with a field violation (§8.3)', async (_name, details) => {
    const { employerUserId, applicationId } = await applied();

    await expect(
      interviews.schedule(employerUserId, applicationId, {
        ...details,
        scheduledAt: AT,
      }),
    ).rejects.toThrow(ValidationFailedException);
  });

  it('accepts each type in its own shape', async () => {
    const { employerUserId, applicationId } = await applied();

    const inPerson = await interviews.schedule(employerUserId, applicationId, {
      type: 'in_person',
      scheduledAt: AT,
      location: 'Amir Temur 1',
    });
    const link = await interviews.schedule(employerUserId, applicationId, {
      type: 'external_link',
      scheduledAt: AT,
      meetingLink: 'https://meet.example/abc',
    });

    expect(inPerson.location).toBe('Amir Temur 1');
    expect(inPerson.meetingLink).toBeNull();
    expect(link.meetingLink).toBe('https://meet.example/abc');
    expect(link.location).toBeNull();
  });

  it('keeps the instant, so both sides read the same moment (§8.3)', async () => {
    const { employerUserId, applicationId } = await applied();

    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });

    expect(interview.scheduledAt.toISOString()).toBe(AT.toISOString());
  });
});

describe('the candidate’s response (§8.3)', () => {
  async function scheduled(): Promise<{
    employerUserId: string;
    candidateUserId: string;
    applicationId: string;
    interviewId: string;
  }> {
    const context = await applied();
    const interview = await interviews.schedule(
      context.employerUserId,
      context.applicationId,
      { type: 'phone', scheduledAt: AT },
    );

    return { ...context, interviewId: interview.id };
  }

  it('confirms, with its BR-08 history row', async () => {
    const { candidateUserId, interviewId } = await scheduled();

    const confirmed = await interviews.respond(
      candidateUserId,
      interviewId,
      'confirmed',
      'See you then.',
    );

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.respondedAt).not.toBeNull();
    expect(confirmed.responseNote).toBe('See you then.');
    expect(await interviews.history(interviewId)).toEqual([
      expect.objectContaining({ toStatus: 'scheduled', actorRole: 'employer' }),
      expect.objectContaining({
        fromStatus: 'scheduled',
        toStatus: 'confirmed',
        actorRole: 'candidate',
        reason: 'See you then.',
      }),
    ]);
  });

  it('asks for another time, and may still change its mind afterwards', async () => {
    const { candidateUserId, interviewId } = await scheduled();

    await interviews.respond(
      candidateUserId,
      interviewId,
      'reschedule_requested',
      'Could we do Thursday?',
    );
    const confirmed = await interviews.respond(
      candidateUserId,
      interviewId,
      'confirmed',
      null,
    );

    expect(confirmed.status).toBe('confirmed');
    expect(await interviews.history(interviewId)).toHaveLength(3);
  });

  it('refuses the same answer twice', async () => {
    const { candidateUserId, interviewId } = await scheduled();
    await interviews.respond(candidateUserId, interviewId, 'confirmed', null);

    await expect(
      interviews.respond(candidateUserId, interviewId, 'confirmed', null),
    ).rejects.toThrow(ConflictError);
  });

  it('never lets one candidate answer another’s interview', async () => {
    const { interviewId } = await scheduled();
    const stranger = await newCandidate();

    await expect(
      interviews.respond(stranger, interviewId, 'confirmed', null),
    ).rejects.toThrow(NotFoundError);
  });

  it('shows the interview to both sides and nobody else', async () => {
    const { employerUserId, candidateUserId, applicationId, interviewId } =
      await scheduled();
    const stranger = await newEmployer();

    expect(
      (
        await interviews.listForApplication(
          employerUserId,
          'employer',
          applicationId,
        )
      ).map((item) => item.id),
    ).toEqual([interviewId]);
    expect(
      (
        await interviews.listForApplication(
          candidateUserId,
          'candidate',
          applicationId,
        )
      ).map((item) => item.id),
    ).toEqual([interviewId]);
    await expect(
      interviews.listForApplication(stranger, 'employer', applicationId),
    ).rejects.toThrow(NotFoundError);
  });

  it('lists a candidate’s interviews across applications, without cancelled ones', async () => {
    const { employerUserId, candidateUserId, interviewId } = await scheduled();

    expect(
      (await interviews.listForCandidate(candidateUserId)).map(
        (item) => item.id,
      ),
    ).toEqual([interviewId]);

    await interviews.cancel(employerUserId, interviewId, 'Role filled.');

    expect(await interviews.listForCandidate(candidateUserId)).toEqual([]);
  });
});

describe('rescheduling and cancelling', () => {
  it('resets a confirmation when the time moves', async () => {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });
    await interviews.respond(
      candidateUserId,
      interview.id,
      'confirmed',
      'See you then.',
    );

    const moved = await interviews.reschedule(employerUserId, interview.id, {
      type: 'in_person',
      scheduledAt: new Date('2026-08-21T09:00:00.000Z'),
      location: 'Amir Temur 1',
    });

    // A new time has not been confirmed, whatever was said about the old one - and the
    // note that went with the old answer goes with it.
    expect(moved.status).toBe('scheduled');
    expect(moved.respondedAt).toBeNull();
    expect(moved.responseNote).toBeNull();
    expect(moved.location).toBe('Amir Temur 1');
  });

  it('clears the detail that no longer applies when the type changes', async () => {
    const { employerUserId, applicationId } = await applied();
    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'in_person',
      scheduledAt: AT,
      location: 'Amir Temur 1',
    });

    const moved = await interviews.reschedule(employerUserId, interview.id, {
      type: 'phone',
      scheduledAt: AT,
    });

    // A full replacement rather than a patch, so a phone interview cannot keep the
    // address of the in-person one it used to be.
    expect(moved.location).toBeNull();
    expect(moved.meetingLink).toBeNull();
  });

  it('refuses to reschedule or answer a cancelled interview', async () => {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });
    await interviews.cancel(employerUserId, interview.id, 'Role filled.');

    await expect(
      interviews.reschedule(employerUserId, interview.id, {
        type: 'phone',
        scheduledAt: AT,
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      interviews.respond(candidateUserId, interview.id, 'confirmed', null),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a shape the type does not permit, on reschedule too', async () => {
    const { employerUserId, applicationId } = await applied();
    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });

    await expect(
      interviews.reschedule(employerUserId, interview.id, {
        type: 'external_link',
        scheduledAt: AT,
      }),
    ).rejects.toThrow(ValidationFailedException);
  });
});

describe('the CHECK constraint behind §8.3', () => {
  it('refuses a mismatched shape even from a direct write', async () => {
    const { employerUserId, applicationId } = await applied();
    await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });

    // The service validates and answers with a field violation; the constraint is what
    // makes the rule true of the table, including for a manual SQL fix.
    await expect(
      db
        .insertInto('interviews')
        .values({
          application_id: applicationId,
          type: 'in_person',
          scheduled_at: AT,
          location: null,
        })
        .execute(),
    ).rejects.toThrow(/interviews_location_matches_type/);
  });

  it('refuses a response timestamp that disagrees with the status', async () => {
    const { employerUserId, applicationId } = await applied();
    const interview = await interviews.schedule(employerUserId, applicationId, {
      type: 'phone',
      scheduledAt: AT,
    });

    await expect(
      db
        .updateTable('interviews')
        .set({ responded_at: AT })
        .where('id', '=', interview.id)
        .execute(),
    ).rejects.toThrow(/interviews_responded_at_matches_status/);
  });
});
