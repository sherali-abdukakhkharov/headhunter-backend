import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { DiscoveryService } from '@modules/discovery/discovery.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';

import { ApplicationsService } from './applications.service';
import { CandidateViewService } from './candidate-view.service';

/**
 * Integration tests against a real Postgres, covering the MVP's closing loop.
 *
 * These cannot be unit tests. BR-07 is a partial unique index and the test that matters
 * most fires two applies concurrently to prove it. BR-06 is checked inside a transaction
 * against a row read `FOR SHARE`. BR-08's history and §6.5's hire counter are written in
 * the same transaction as the status change. Over `DummyDriver` all of it would compile,
 * run nothing, and pass.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let vacancies: VacanciesService;
let candidates: CandidatesService;
let applications: ApplicationsService;
let candidateView: CandidateViewService;
let discovery: DiscoveryService;

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
  candidateView = new CandidateViewService(
    db,
    employers,
    new HiringInteractionService(db),
    // Files are not exercised by these tests - the BR-09 *decision* is what they cover,
    // and `infra/files` has its own suite. A stub keeps Telegram out of them.
    {
      readAsAuthorized: () =>
        Promise.reject(new Error('not used by these tests')),
    } as never,
  );
  discovery = new DiscoveryService(db, config);
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
  const phone = fixturePhone();
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
}

/** A verified employer with one published vacancy - the state a candidate can apply into. */
async function publishedVacancy(
  options: { deadlineOn?: string } = {},
): Promise<{
  employerUserId: string;
  vacancyId: string;
}> {
  const employerUserId = await newUser('employer');
  const { regionId, districtId } = await region();

  await employers.upsert(employerUserId, 'company', {
    contactPhone: '+998901234567',
    regionId,
    legalName: 'Uzum Market LLC',
    publicName: 'Uzum',
    industryId: await anyActive('industry'),
    contactPersonName: 'Anvar Karimov',
    description: 'Marketplace operator hiring call-centre staff.',
  });

  const verification = new VerificationService(
    db,
    employers,
    notifications,
    config,
  );
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
  await verification.submit(employerUserId, [file.id]);

  const draft = await vacancies.create(employerUserId);
  const vacancyId = draft.aggregate.row.id;

  await vacancies.patch(employerUserId, vacancyId, {
    occupation_id: await seededId('occupation', 'software_developer'),
    title: 'Backend developer',
    description: 'Build and maintain the marketplace API, with care and tests.',
    worker_count: 3,
    region_id: regionId,
    district_id: districtId,
    employment_type_ids: [await seededId('employment_type', 'full_time')],
    salary: {
      from: 15_000_000,
      to: 25_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
    ...(options.deadlineOn ? { deadline_on: options.deadlineOn } : {}),
  });
  await vacancies.submit(employerUserId, vacancyId);

  return { employerUserId, vacancyId };
}

/**
 * A candidate with a profile, which BR-02 requires before applying.
 *
 * Visibility is set to `searchable` deliberately: a profile is `hidden` by default
 * (§11.1), and leaving it that way would make every BR-09 assertion here pass or fail on
 * the *privacy* half of the rule when what these tests are about is the *interaction*
 * half. The privacy half is covered by `contact-exposure.spec.ts` against all three
 * settings.
 */
async function newCandidate(): Promise<string> {
  const userId = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(userId, {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'software_developer'),
  });
  await candidates.setVisibility(userId, 'searchable');

  return userId;
}

describe('applying (BR-02, BR-06, BR-07, BR-08)', () => {
  it('creates an application with its history row in one transaction', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      'I have five years on similar systems.',
    );

    expect(application.status).toBe('submitted');
    expect(application.coverNote).toContain('five years');

    // BR-08: an application without its history row must not exist.
    const history = await applications.history(application.id);
    expect(history).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'submitted',
        actorRole: 'candidate',
      }),
    ]);
  });

  it('refuses an application from a candidate with no profile (BR-02)', async () => {
    const { vacancyId } = await publishedVacancy();
    const userId = await newUser('candidate');

    await expect(applications.apply(userId, vacancyId, null)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('refuses a second active application to the same vacancy (BR-07)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    await applications.apply(candidateUserId, vacancyId, null);

    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toThrow(ConflictError);
  });

  it('produces exactly one application from a concurrent double-apply (BR-07)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    // The case the partial unique index exists for: a flaky connection, one double-tap,
    // two requests in flight. A service-layer "does one exist" check loses this race, so
    // the index has to win it - one of these must fail.
    const results = await Promise.allSettled([
      applications.apply(candidateUserId, vacancyId, null),
      applications.apply(candidateUserId, vacancyId, null),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const rows = await db
      .selectFrom('applications')
      .select('id')
      .where('vacancy_id', '=', vacancyId)
      .where('candidate_user_id', '=', candidateUserId)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('lets a candidate apply again after withdrawing (BR-07 counts only active ones)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const first = await applications.apply(candidateUserId, vacancyId, null);
    await applications.withdraw(candidateUserId, first.id);

    const second = await applications.apply(candidateUserId, vacancyId, null);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('submitted');
  });

  it('refuses an application after the deadline (BR-06)', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    // Set the deadline into the past directly: the submit path refuses to publish one
    // that has already passed, and what BR-06 guards is the window closing *afterwards*.
    await db
      .updateTable('vacancies')
      .set({ deadline_on: '2020-01-01' })
      .where('id', '=', vacancyId)
      .execute();

    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toThrow(ConflictError);

    expect(employerUserId).toBeTruthy();
  });

  it('refuses an application to a closed or paused vacancy (BR-11, BR-04)', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    await vacancies.changeStatus(employerUserId, vacancyId, 'paused', null);
    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toThrow(ConflictError);

    await vacancies.changeStatus(employerUserId, vacancyId, 'active', null);
    await vacancies.changeStatus(
      employerUserId,
      vacancyId,
      'closed',
      'Filled.',
    );
    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toThrow(ConflictError);
  });

  it('replays the original application for a repeated Idempotency-Key (§12.4)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const key = randomUUID();

    const first = await applications.apply(
      candidateUserId,
      vacancyId,
      'Hello',
      key,
    );
    // The dangerous case: the request succeeded and its response was lost, so the client
    // retries. BR-07 alone would answer with a conflict, which is indistinguishable from
    // "somebody else got there first"; the key makes the retry a success, because it was.
    const replay = await applications.apply(
      candidateUserId,
      vacancyId,
      'Hello',
      key,
    );

    expect(replay.id).toBe(first.id);
  });

  it('rejects the same key used for a different request', async () => {
    const { vacancyId } = await publishedVacancy();
    const other = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const key = randomUUID();

    await applications.apply(candidateUserId, vacancyId, null, key);

    await expect(
      applications.apply(candidateUserId, other.vacancyId, null, key),
    ).rejects.toThrow(ConflictError);
  });
});

describe('stages (§8.1, §6.5)', () => {
  async function applied() {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      null,
    );

    return { employerUserId, vacancyId, candidateUserId, application };
  }

  it('records every move with its actor (BR-08)', async () => {
    const { employerUserId, application } = await applied();

    await applications.moveStage(
      employerUserId,
      application.id,
      'viewed',
      null,
    );
    await applications.moveStage(
      employerUserId,
      application.id,
      'shortlisted',
      null,
    );

    const history = await applications.history(application.id);

    expect(history.map((entry) => entry.toStatus)).toEqual([
      'submitted',
      'viewed',
      'shortlisted',
    ]);
    expect(history[2].actorRole).toBe('employer');
  });

  it('refuses a backwards move', async () => {
    const { employerUserId, application } = await applied();
    await applications.moveStage(
      employerUserId,
      application.id,
      'shortlisted',
      null,
    );

    await expect(
      applications.moveStage(employerUserId, application.id, 'viewed', null),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses an employer trying to withdraw on the candidate’s behalf (§8.1)', async () => {
    const { employerUserId, application } = await applied();

    // The route's DTO already narrows this, but the rule belongs with the machine: a
    // future admin route must not be able to withdraw for somebody by accident.
    await expect(
      applications.moveStage(employerUserId, application.id, 'withdrawn', null),
    ).rejects.toThrow(ForbiddenError);
  });

  it('counts a hire against the vacancy’s requirement in the same transaction (§6.5)', async () => {
    const { employerUserId, vacancyId, application } = await applied();

    await applications.moveStage(employerUserId, application.id, 'hired', null);

    const counts = await applications.countsForVacancy(
      employerUserId,
      vacancyId,
    );

    expect(counts.hiredCount).toBe(1);
    expect(counts.workerCount).toBe(3);
    expect(counts.byStatus.hired).toBe(1);
  });

  it('keeps a rejection reason and shows it to the candidate (§8.1)', async () => {
    const { employerUserId, candidateUserId, application } = await applied();

    await applications.moveStage(
      employerUserId,
      application.id,
      'rejected',
      'We filled the role internally.',
    );

    const mine = await applications.listForCandidate(candidateUserId);

    expect(mine[0].status).toBe('rejected');
    expect(mine[0].rejectionReason).toBe('We filled the role internally.');
  });

  it('refuses any move once the application is final', async () => {
    const { employerUserId, application } = await applied();
    await applications.moveStage(employerUserId, application.id, 'hired', null);

    await expect(
      applications.moveStage(employerUserId, application.id, 'rejected', null),
    ).rejects.toThrow(ConflictError);
  });

  it('never lets one employer touch another’s applications', async () => {
    const { application } = await applied();
    const other = await publishedVacancy();

    // 404 rather than 403: an employer must not learn that an application id exists on
    // somebody else's vacancy (§11.1).
    await expect(
      applications.moveStage(
        other.employerUserId,
        application.id,
        'viewed',
        null,
      ),
    ).rejects.toThrow(NotFoundError);
    await expect(
      applications.addNote(other.employerUserId, application.id, 'Mine now'),
    ).rejects.toThrow(NotFoundError);
  });

  it('never lets one candidate withdraw another’s application', async () => {
    const { application } = await applied();
    const other = await newCandidate();

    await expect(applications.withdraw(other, application.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('the employer’s view of an applicant (§6.5, BR-09)', () => {
  it('reveals the phone number once the candidate has applied', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      null,
    );

    const view = await candidateView.forApplication(
      employerUserId,
      application.id,
    );

    expect(view.exposureReason).toBe('application');
    expect(view.phone).toMatch(/^\+998/);
    expect(view.canViewFiles).toBe(true);
  });

  it('reveals nothing about a candidate who has not applied to this employer', async () => {
    const { employerUserId } = await publishedVacancy();
    const other = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const application = await applications.apply(
      candidateUserId,
      other.vacancyId,
      null,
    );

    // The application belongs to another employer's vacancy, so this one cannot even
    // name it - let alone read the candidate behind it.
    await expect(
      candidateView.forApplication(employerUserId, application.id),
    ).rejects.toThrow(NotFoundError);
  });

  it('withdraws the exposure when the candidate withdraws', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      null,
    );
    await applications.withdraw(candidateUserId, application.id);

    const view = await candidateView.forApplication(
      employerUserId,
      application.id,
    );

    // A withdrawal takes back the request to be contacted, so BR-09's interaction half
    // stops holding. **Still a rule after M12, now one of three** - and the reason code says
    // what changed: the employer is not permanently refused, they are told that what used to
    // be free is now a purchase. This assertion moved from `no_interaction` deliberately.
    expect(view.phone).toBeNull();
    expect(view.canViewFiles).toBe(false);
    expect(view.files).toEqual([]);
    expect(view.exposureReason).toBe('unlock_required');
  });

  it('keeps internal notes out of every candidate-facing read (§6.5)', async () => {
    const { employerUserId, candidateUserId, vacancyId } = {
      ...(await publishedVacancy()),
      candidateUserId: await newCandidate(),
    };
    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      null,
    );
    await applications.addNote(employerUserId, application.id, 'Weak on SQL.');

    const notes = await applications.listNotes(employerUserId, application.id);
    expect(notes).toHaveLength(1);

    // Nothing the candidate can read carries it: the note lives in its own table, so
    // exposing it would take a deliberate new query rather than a forgotten column.
    const mine = await applications.listForCandidate(candidateUserId);
    expect(JSON.stringify(mine)).not.toContain('Weak on SQL');

    const history = await applications.history(application.id);
    expect(JSON.stringify(history)).not.toContain('Weak on SQL');
  });
});

describe('discovery (§5.5, §5.6)', () => {
  const filters = { limit: 20, offset: 0 };

  it('shows an active vacancy in the recent feed with the employer’s verified badge', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    const feed = await discovery.recent(candidateUserId, filters);
    const item = feed.find((entry) => entry.id === vacancyId);

    expect(item).toBeDefined();
    expect(item?.employer.isVerified).toBe(true);
    expect(item?.employer.name).toBe('Uzum');
    expect(item?.applicationStatus).toBeNull();
  });

  it('hides a paused or closed vacancy from the feed (BR-04, BR-11)', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    await vacancies.changeStatus(employerUserId, vacancyId, 'paused', null);

    const feed = await discovery.recent(candidateUserId, filters);
    expect(feed.map((item) => item.id)).not.toContain(vacancyId);

    // And the detail agrees - a feed and a detail that disagree is how a candidate gets
    // a 404 from a card they can see.
    await expect(discovery.detail(candidateUserId, vacancyId)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('hides a vacancy whose deadline has passed (BR-06)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    await db
      .updateTable('vacancies')
      .set({ deadline_on: '2020-01-01' })
      .where('id', '=', vacancyId)
      .execute();

    const feed = await discovery.recent(candidateUserId, filters);

    // The feed and the apply route read the same definition, so what is listed can be
    // applied to.
    expect(feed.map((item) => item.id)).not.toContain(vacancyId);
  });

  it('reports the candidate’s own application on the card (§5.6)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    await applications.apply(candidateUserId, vacancyId, null);

    const feed = await discovery.recent(candidateUserId, filters);
    const item = feed.find((entry) => entry.id === vacancyId);

    expect(item?.applicationStatus).toBe('submitted');
  });

  it('ranks a matching occupation above an unrelated one (§5.5)', async () => {
    const matching = await publishedVacancy();
    const candidateUserId = await newCandidate();

    const feed = await discovery.recommended(candidateUserId, filters);
    const position = feed.findIndex((item) => item.id === matching.vacancyId);

    // The candidate's primary occupation is `software_developer`, which is what this
    // vacancy asks for, so it must not be buried behind unrelated recent postings.
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
  });

  it('filters by region, occupation and salary floor (§5.5)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    const { regionId } = await region();

    const matched = await discovery.recent(candidateUserId, {
      ...filters,
      regionId,
      occupationIds: [await seededId('occupation', 'software_developer')],
      salaryFrom: 10_000_000,
    });
    expect(matched.map((item) => item.id)).toContain(vacancyId);

    const excluded = await discovery.recent(candidateUserId, {
      ...filters,
      salaryFrom: 900_000_000,
    });
    expect(excluded.map((item) => item.id)).not.toContain(vacancyId);
  });

  it('keeps a saved vacancy visible after it closes (§5.5)', async () => {
    const { employerUserId, vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();
    await discovery.save(candidateUserId, vacancyId);
    await vacancies.changeStatus(
      employerUserId,
      vacancyId,
      'closed',
      'Filled.',
    );

    const saved = await discovery.saved(candidateUserId, filters);

    // BR-11 removes it from *discovery*; a personal list is not discovery, and a saved
    // item that vanished would look like a bug to the candidate.
    expect(saved.map((item) => item.id)).toContain(vacancyId);
  });

  it('treats saving twice as saving once', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    await discovery.save(candidateUserId, vacancyId);
    await discovery.save(candidateUserId, vacancyId);

    const saved = await discovery.saved(candidateUserId, filters);
    expect(saved.filter((item) => item.id === vacancyId)).toHaveLength(1);

    await discovery.unsave(candidateUserId, vacancyId);
    expect(await discovery.saved(candidateUserId, filters)).toEqual([]);
  });

  it('files one complaint per person per vacancy (§5.6)', async () => {
    const { vacancyId } = await publishedVacancy();
    const candidateUserId = await newCandidate();

    const id = await discovery.report(
      candidateUserId,
      vacancyId,
      'The pay in the description does not match the listed range.',
    );
    expect(id).toBeTruthy();

    await expect(
      discovery.report(candidateUserId, vacancyId, 'Same complaint again.'),
    ).rejects.toThrow(ConflictError);

    const row = await db
      .selectFrom('complaints')
      .select(['target_type', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    // Filed for M10's queue rather than acted on now.
    expect(row).toEqual({ target_type: 'vacancy', status: 'open' });
  });
});
