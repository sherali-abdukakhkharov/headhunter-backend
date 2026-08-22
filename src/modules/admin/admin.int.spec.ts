import { randomUUID } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { AccountStatusGuard } from '@infra/api/guards/account-status.guard';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { formatDateOnly, formatRowTimestamps } from '@infra/time/format';
import type { AppEnv } from '@infra/env-schema';
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

import { AUDIT_ACTIONS, AuditService } from './audit.service';
import { DashboardService } from './dashboard.service';
import { DictionaryAdminService } from './dictionary-admin.service';
import { AdminModerationService } from './moderation.service';
import { AdminUsersService } from './users-admin.service';

/**
 * §10's administration against a real Postgres.
 *
 * The test this file exists for is the first one: **the audit log is append-only**, and
 * that is a property of the table rather than of this module having no write path. Three
 * statement-level triggers enforce it, and a service without an update method would prove
 * nothing about a migration, a `psql` session or the next service.
 *
 * The second reason is that M10 is where the two MVP flags come on. Both are `true` here,
 * so submission parks in a queue - which is the behaviour the product has been deferring
 * since M4 and M5, and a BR-12 restricted vacancy publishing for the first time is the
 * clearest proof that the deferral was only ever about the missing reviewer.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let verification: VerificationService;
let candidates: CandidatesService;
let vacancies: VacanciesService;
let audit: AuditService;
let dashboard: DashboardService;
let moderation: AdminModerationService;
let adminUsers: AdminUsersService;
let adminDictionaries: DictionaryAdminService;
let guard: AccountStatusGuard;
let dictionariesRead: DictionariesService;

/**
 * The real notifications service over a no-op sender.
 *
 * Real rather than stubbed, so every one of these suites also exercises the notification
 * write M9 added to the flow it covers; no-op sender, so nothing reaches FCM.
 */
let notifications: NotificationsService;

const users: string[] = [];
const createdItems: string[] = [];

/** Both flags **on**: M10 is the reviewer they were waiting for. */
const config = {
  get: (key: string) =>
    key === 'PLATFORM_TIME_ZONE'
      ? 'Asia/Tashkent'
      : key === 'MODERATION_ENABLED' || key === 'EMPLOYER_VERIFICATION_ENABLED'
        ? true
        : key === 'FILE_MAX_SIZE_BYTES'
          ? 10_485_760
          : undefined,
} as unknown as ConfigService<AppEnv, true>;

const filesStub = {
  readAsAuthorized: (ownerUserId: string, fileId: string) =>
    Promise.resolve({
      file: {
        id: fileId,
        purposeId: 'p',
        fileName: 'registration.pdf',
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
  dictionariesRead = dictionaries;
  const schemas = new SchemasService(db, dictionaries, config);
  const validator = new FieldValidatorService(dictionaries, config);

  employers = new EmployersService(db);
  verification = new VerificationService(db, employers, notifications, config);
  candidates = new CandidatesService(db, schemas, validator);
  vacancies = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    notifications,
    config,
  );
  audit = new AuditService(db);
  dashboard = new DashboardService(db, config);
  moderation = new AdminModerationService(
    db,
    verification,
    vacancies,
    filesStub,
    audit,
  );
  adminUsers = new AdminUsersService(db, audit, notifications, config);
  adminDictionaries = new DictionaryAdminService(db, audit);
  guard = new AccountStatusGuard(db);
});

afterAll(async () => {
  for (const id of createdItems) {
    await db
      .deleteFrom('dictionary_item_translations')
      .where('item_id', '=', id)
      .execute();
    await db.deleteFrom('dictionary_items').where('id', '=', id).execute();
  }

  for (const id of users) {
    // **The audit rows and the administrators who wrote them are left behind**, and that
    // is the design rather than an oversight: the log is append-only (§10.4) and its actor
    // reference is RESTRICT, so nothing - not even its own test - can erase who acted.
    // BR-14's purge will have to answer for these rows explicitly, which is exactly the
    // conversation the constraint forces.
    const actor = await db
      .selectFrom('admin_audit_log')
      .select('id')
      .where('actor_user_id', '=', id)
      .executeTakeFirst();

    if (actor) {
      continue;
    }

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

async function newUser(
  role: 'candidate' | 'employer' | 'admin',
): Promise<string> {
  const phone = `+99895${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
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

/** An employer whose submission is **queued**, because the flag is on now. */
async function submittedEmployer(): Promise<{
  employerUserId: string;
  fileId: string;
}> {
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

  const fileId = await evidenceFile(employerUserId);
  await verification.submit(employerUserId, [fileId]);

  return { employerUserId, fileId };
}

async function verifiedEmployer(): Promise<string> {
  const { employerUserId } = await submittedEmployer();
  const adminUserId = await newUser('admin');

  await moderation.decideVerification(
    adminUserId,
    employerUserId,
    'verified',
    null,
  );

  return employerUserId;
}

async function draftVacancy(
  employerUserId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
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
    ...extra,
  });

  return vacancyId;
}

describe('the audit log is append-only (§10.4)', () => {
  async function oneRow(): Promise<{ id: string; actorUserId: string }> {
    const actorUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    await adminUsers.warn(actorUserId, targetUserId, 'First warning.');
    const [entry] = await audit.list({ actorUserId }, 1, 0);

    return { id: entry.id, actorUserId };
  }

  it('refuses an UPDATE', async () => {
    const { id } = await oneRow();

    await expect(
      db
        .updateTable('admin_audit_log')
        .set({ reason: 'rewritten' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    const { id } = await oneRow();

    await expect(
      db.deleteFrom('admin_audit_log').where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses an UPDATE that matches nothing, which a row trigger would allow', async () => {
    // The reason the triggers are statement-level: a row-level trigger never fires for a
    // statement that matches no rows, so this would report a success it did not perform.
    await expect(
      db
        .updateTable('admin_audit_log')
        .set({ reason: 'rewritten' })
        .where('id', '=', randomUUID())
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a TRUNCATE, which would otherwise be the way around the other two', async () => {
    await expect(
      db.executeQuery({
        sql: 'TRUNCATE admin_audit_log',
        parameters: [],
        query: { kind: 'RawNode' } as never,
        queryId: { queryId: 'truncate-audit-log' },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('§10.1 dashboard', () => {
  it('counts the queues and the period', async () => {
    await submittedEmployer();

    // `formatDateOnly`, not `toISOString().slice` - in Tashkent that is yesterday for five
    // hours a day, and with the period bounds now resolved in the platform zone an
    // employer created at 02:00 would fall outside a period ending "today".
    const today = formatDateOnly(new Date(), 'Asia/Tashkent');
    const counters = await dashboard.counters('2020-01-01', today);

    expect(counters.period).toEqual({ from: '2020-01-01', to: today });
    // The employer just submitted, so the verification queue cannot be empty.
    expect(counters.awaitingVerification).toBeGreaterThanOrEqual(1);
    expect(counters.employers.total).toBeGreaterThanOrEqual(1);
    expect(counters.employers.new).toBeGreaterThanOrEqual(1);
  });

  it('files an 02:00 Tashkent registration under its own day, not the previous one', async () => {
    // The bug this test exists for: every one of these counts compared a `timestamptz`
    // against a bare `::date`, which Postgres resolves in the *session* zone - UTC on this
    // deployment. `created_at >= '2026-03-15'::date` therefore meant 05:00 Tashkent, and an
    // employer who registered at 02:00 was counted in the previous day. It cannot be caught
    // by reading the SQL, because every machine on this project sits at UTC+5 and the
    // numbers looked plausible.
    //
    // Asserted as a delta rather than an absolute, because this database is shared with the
    // dev server and the seed loader.
    const employerUserId = await newUser('employer');
    const { regionId } = await region();
    await employers.upsert(employerUserId, 'individual', {
      fullName: 'Boundary Case',
      contactPhone: '+998900000001',
      regionId,
      description: 'Registered in the small hours.',
    });

    const before = await dashboard.counters('2026-03-15', '2026-03-15');
    const beforePreviousDay = await dashboard.counters(
      '2026-03-14',
      '2026-03-14',
    );

    await db
      .updateTable('employers')
      .set({ created_at: new Date('2026-03-15T02:00:00+05:00') })
      .where('user_id', '=', employerUserId)
      .execute();

    const after = await dashboard.counters('2026-03-15', '2026-03-15');
    const afterPreviousDay = await dashboard.counters(
      '2026-03-14',
      '2026-03-14',
    );

    expect(after.employers.new).toBe(before.employers.new + 1);
    expect(afterPreviousDay.employers.new).toBe(
      beforePreviousDay.employers.new,
    );
  });
});

describe('§10.2 employer verification', () => {
  it('queues a submission, shows its evidence, and verifies it with an audit row', async () => {
    const { employerUserId, fileId } = await submittedEmployer();
    const adminUserId = await newUser('admin');

    const queue = await moderation.verificationQueue(100, 0);
    const item = queue.find((row) => row.employerUserId === employerUserId);

    expect(item).toBeDefined();
    expect(item?.files.map((file) => file.id)).toContain(fileId);
    // Never a storage URL: Telegram's carries the bot token (ARCHITECTURE.md §9).
    expect(item?.files[0].path).toContain('/admin/employers/');

    await moderation.decideVerification(
      adminUserId,
      employerUserId,
      'verified',
      null,
    );

    expect((await employers.gate(employerUserId)).isVerified).toBe(true);

    const [entry] = await audit.list(
      { targetType: 'employer', targetId: employerUserId },
      10,
      0,
    );
    expect(entry).toMatchObject({
      action: AUDIT_ACTIONS.verificationDecided,
      actorUserId: adminUserId,
      details: { decision: 'verified' },
    });
  });

  it('refuses a rejection with no reason (§10.2), and keeps the queue', async () => {
    const { employerUserId } = await submittedEmployer();
    const adminUserId = await newUser('admin');

    await expect(
      moderation.decideVerification(
        adminUserId,
        employerUserId,
        'rejected',
        '  ',
      ),
    ).rejects.toThrow(ForbiddenError);

    expect((await employers.find(employerUserId))?.verificationStatus).toBe(
      'under_review',
    );
  });

  it('serves evidence only for the employer it belongs to', async () => {
    const { employerUserId, fileId } = await submittedEmployer();
    const other = await submittedEmployer();
    const adminUserId = await newUser('admin');

    await expect(
      moderation.downloadEvidence(adminUserId, employerUserId, fileId),
    ).resolves.toMatchObject({ file: { mimeType: 'application/pdf' } });

    // An administrator may read evidence, not any file whose id they can name.
    await expect(
      moderation.downloadEvidence(adminUserId, other.employerUserId, fileId),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('§10.2 vacancy moderation', () => {
  it('publishes an ordinary vacancy only after approval (BR-04)', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId);

    const submitted = await vacancies.submit(employerUserId, vacancyId);

    // With MODERATION_ENABLED on, submission queues rather than publishing - the
    // behaviour the flag was hiding until there was a reviewer.
    expect(submitted.aggregate.row.status).toBe('under_moderation');

    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    const after = await vacancies.read(employerUserId, vacancyId);
    expect(after.aggregate.row.status).toBe('active');
    expect(after.aggregate.row.published_at).not.toBeNull();
  });

  it('finally lets a BR-12 restricted vacancy publish, and shows why it was queued', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId, {
      age_min: 21,
      restriction_justification_id: await seededId(
        'restriction_justification',
        'statutory_minimum_age',
      ),
      restriction_justification_note: 'Alcohol is served on the premises.',
    });
    await vacancies.submit(employerUserId, vacancyId);

    const queue = await moderation.moderationQueue(100, 0);
    const item = queue.find((row) => row.vacancyId === vacancyId);

    // §10.2 requires the restriction to be reviewed, so the queue says which items carry
    // one rather than making an administrator open each to find out.
    expect(item?.restriction).toMatchObject({
      ageMin: 21,
      justificationNote: 'Alcohol is served on the premises.',
    });

    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    // This is the state that was unreachable from M5 until now: a restricted vacancy that
    // published, because a person approved it.
    expect(
      (await vacancies.read(employerUserId, vacancyId)).aggregate.row.status,
    ).toBe('active');
  });

  it('names the employer on the review, so a deep link is not a bare uuid (§10.2)', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId);
    await vacancies.submit(employerUserId, vacancyId);

    const { aggregate, employer } = await moderation.vacancyForReview(
      adminUserId,
      vacancyId,
    );

    expect(aggregate.row.id).toBe(vacancyId);

    // §10.2 lists contact information among what is reviewed, and the review must show the
    // **same** name the queue showed - one expression, so tapping a queue row cannot land
    // on a screen naming somebody else.
    const queued = (await moderation.moderationQueue(100, 0)).find(
      (row) => row.vacancyId === vacancyId,
    );
    expect(employer.name).toBe('Uzum');
    expect(queued?.employerName).toBe(employer.name);

    // Two numbers with different meanings, which is why they are two fields rather than a
    // COALESCE: the account number is §10.4's search key and is always there, the contact
    // number is what this employer published for their company and may be neither.
    expect(employer.contactPhone).toBe('+998901234567');
    expect(employer.phone).toMatch(/^\+99895/);
  });

  it('falls back to an individual employer’s own name, having no company', async () => {
    const employerUserId = await newUser('employer');
    const adminUserId = await newUser('admin');
    const { regionId } = await region();

    // §6.1's individual fields, all four - anything less and BR-03 refuses the vacancy
    // before there is a review to look at.
    await employers.upsert(employerUserId, 'individual', {
      fullName: 'Dilnoza Yusupova',
      contactPhone: '+998911112233',
      regionId,
      description: 'Hiring a shop assistant for a family business.',
    });
    await verification.submit(employerUserId, []);
    await moderation.decideVerification(
      await newUser('admin'),
      employerUserId,
      'verified',
      null,
    );

    const vacancyId = await draftVacancy(employerUserId);
    const { employer } = await moderation.vacancyForReview(
      adminUserId,
      vacancyId,
    );

    // The `companies` join is a LEFT join for exactly this row: an individual has no
    // public name, and the review must still say who this is.
    expect(employer.name).toBe('Dilnoza Yusupova');
    expect(employer.contactPhone).toBe('+998911112233');
  });

  it('rejects with a reason, and refuses one without', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId);
    await vacancies.submit(employerUserId, vacancyId);

    await expect(
      moderation.moderateVacancy(adminUserId, vacancyId, 'rejected', '   '),
    ).rejects.toThrow(ForbiddenError);

    await moderation.moderateVacancy(
      adminUserId,
      vacancyId,
      'rejected',
      'The salary range contradicts the description.',
    );

    const after = await vacancies.read(employerUserId, vacancyId);
    expect(after.aggregate.row.status).toBe('rejected');
    expect(after.aggregate.row.moderation_reason).toContain('contradicts');
  });

  it('pauses a live vacancy with an audit record (§10.2)', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId);
    await vacancies.submit(employerUserId, vacancyId);
    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    await moderation.administrateVacancy(
      adminUserId,
      vacancyId,
      'paused',
      'Complaint upheld.',
    );

    expect(
      (await vacancies.read(employerUserId, vacancyId)).aggregate.row.status,
    ).toBe('paused');

    const history = await db
      .selectFrom('vacancy_status_history')
      .select(['to_status', 'actor_role', 'reason'])
      .where('vacancy_id', '=', vacancyId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    // BR-08 with an administrator as the actor, not the employer.
    expect(history).toMatchObject({
      to_status: 'paused',
      actor_role: 'admin',
      reason: 'Complaint upheld.',
    });
  });

  it('refuses to pause without a reason', async () => {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const vacancyId = await draftVacancy(employerUserId);

    await expect(
      moderation.administrateVacancy(adminUserId, vacancyId, 'paused', '  '),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('§10.2 complaints', () => {
  async function reportedVacancy(): Promise<{
    complaintId: string;
    vacancyId: string;
  }> {
    const employerUserId = await verifiedEmployer();
    const adminUserId = await newUser('admin');
    const reporterUserId = await newUser('candidate');
    const vacancyId = await draftVacancy(employerUserId);
    await vacancies.submit(employerUserId, vacancyId);
    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    const row = await db
      .insertInto('complaints')
      .values({
        target_type: 'vacancy',
        target_id: vacancyId,
        reporter_user_id: reporterUserId,
        reason: 'This vacancy looks fake.',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { complaintId: row.id, vacancyId };
  }

  it('shows the complaint with enough of its target to judge it', async () => {
    const { complaintId, vacancyId } = await reportedVacancy();

    const { complaint, target } = await moderation.complaint(complaintId);

    expect(complaint.status).toBe('open');
    expect(target).toMatchObject({ id: vacancyId, status: 'active' });
  });

  it('hands back a target whose timestamp the boundary must format (§2)', async () => {
    // The target is columns rather than named fields, and two of the four shapes carry a
    // `created_at`. This pins both halves of that bug: the driver really does return a
    // `Date` here, and `formatRowTimestamps` - which is what the controller applies - turns
    // it into the offset form the contract freezes. A `Z` would throw in the Dart client.
    const reporterUserId = await newUser('candidate');
    const targetUserId = await newUser('candidate');

    const row = await db
      .insertInto('complaints')
      .values({
        target_type: 'user',
        target_id: targetUserId,
        reporter_user_id: reporterUserId,
        reason: 'This account is impersonating a company.',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const { target } = await moderation.complaint(row.id);

    expect(target?.created_at).toBeInstanceOf(Date);
    expect(
      formatRowTimestamps(target ?? {}, 'Asia/Tashkent').created_at,
    ).toMatch(/\+05:00$/);
  });

  it('reviews it once, with its audit row in the same transaction', async () => {
    const { complaintId } = await reportedVacancy();
    const adminUserId = await newUser('admin');

    await moderation.reviewComplaint(
      adminUserId,
      complaintId,
      'dismissed',
      'The vacancy checks out.',
    );

    const complaint = await db
      .selectFrom('complaints')
      .select(['status', 'resolution', 'reviewed_by_user_id'])
      .where('id', '=', complaintId)
      .executeTakeFirstOrThrow();

    expect(complaint).toMatchObject({
      status: 'dismissed',
      reviewed_by_user_id: adminUserId,
    });

    // Nothing else records a complaint review, so unlike a verification decision the audit
    // row is the record - and it is written in the same transaction.
    const [entry] = await audit.list(
      { targetType: 'complaint', targetId: complaintId },
      10,
      0,
    );
    expect(entry).toMatchObject({
      action: AUDIT_ACTIONS.complaintReviewed,
      details: { outcome: 'dismissed' },
    });

    await expect(
      moderation.reviewComplaint(
        adminUserId,
        complaintId,
        'actioned',
        'Changed my mind.',
      ),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a review with no resolution', async () => {
    const { complaintId } = await reportedVacancy();
    const adminUserId = await newUser('admin');

    await expect(
      moderation.reviewComplaint(adminUserId, complaintId, 'actioned', ' '),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('§10.4 user management', () => {
  it('finds a user by partial phone, and by name', async () => {
    const adminUserId = await newUser('admin');
    const candidateUserId = await newUser('candidate');
    const { regionId, districtId } = await region();
    await candidates.patch(candidateUserId, {
      full_name: 'Dilnoza Rashidova',
      date_of_birth: '1996-04-12',
      region_id: regionId,
      district_id: districtId,
      primary_occupation_id: await seededId(
        'occupation',
        'call_centre_operator',
      ),
    });
    const { phone } = await db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', candidateUserId)
      .executeTakeFirstOrThrow();

    const byPhone = await adminUsers.search(
      adminUserId,
      { phone: (phone as string).slice(-6) },
      50,
      0,
    );
    const byName = await adminUsers.search(
      adminUserId,
      { name: 'Dilnoza' },
      50,
      0,
    );

    expect(byPhone.map((row) => row.userId)).toContain(candidateUserId);
    expect(byName.map((row) => row.userId)).toContain(candidateUserId);
    // §10.4 searches by phone, so an administrator sees one - BR-09's `admin` branch.
    expect(byName.find((row) => row.userId === candidateUserId)?.phone).toBe(
      phone,
    );
  });

  it('puts an 02:00 Tashkent registration in its own day, both ways (§10.4)', async () => {
    // The same five-hour shift as the dashboard, and the one an administrator would have
    // noticed second: `registeredFrom` and `registeredTo` compared `u.created_at`, a
    // `timestamptz`, against a bare `::date` that Postgres resolves in the session zone.
    // Somebody who registered at 02:00 on the 15th was absent from "from the 15th" and
    // present in "to the 14th" - filed under the wrong day at both ends of a range.
    const actorUserId = await newUser('admin');
    const userId = await newUser('candidate');

    // A date from before this product existed, so the windows below cannot collide with the
    // seed loader or another test - the search orders newest first, and an old row would
    // otherwise sit past the page limit rather than outside the filter.
    await db
      .updateTable('users')
      .set({ created_at: new Date('2019-02-14T02:00:00+05:00') })
      .where('id', '=', userId)
      .execute();

    const ids = async (registeredFrom: string, registeredTo: string) =>
      (
        await adminUsers.search(
          actorUserId,
          { registeredFrom, registeredTo },
          50,
          0,
        )
      ).map((row) => row.userId);

    // Its own day, at both ends: `from` includes 02:00 rather than starting at 05:00, and
    // `to` is inclusive of the day picked.
    expect(await ids('2019-02-14', '2019-02-14')).toContain(userId);

    // And the previous day does not reach into it, which is the other half of the shift.
    expect(await ids('2019-02-01', '2019-02-13')).not.toContain(userId);
  });

  it('finds an administrator by name, who has no profile to hold one', async () => {
    // The account kind that had no name until `users.full_name` existed: §10 is a role, not
    // a profile, so the `COALESCE` over `candidate_profiles`, `companies` and `employers`
    // returned null and the name filter searched three columns none of which applied. An
    // administrator could not find a colleague in §10.2's own user list.
    const actorUserId = await newUser('admin');
    const colleagueUserId = await newUser('admin');

    await db
      .updateTable('users')
      .set({ full_name: 'Abduqaxxarov Sherali' })
      .where('id', '=', colleagueUserId)
      .execute();

    const found = await adminUsers.search(
      actorUserId,
      { name: 'Abduqaxxarov' },
      50,
      0,
    );

    expect(found.map((row) => row.userId)).toContain(colleagueUserId);
    expect(found.find((row) => row.userId === colleagueUserId)?.name).toBe(
      'Abduqaxxarov Sherali',
    );

    // And the detail renders the same name, which is why both queries share one expression.
    const detail = await adminUsers.detail(actorUserId, colleagueUserId);

    expect(detail.name).toBe('Abduqaxxarov Sherali');
  });

  it('prefers the profile name over the account name, for a user who has both', async () => {
    // `users.full_name` is what the deployment was told; a profile name is what the person
    // maintains. An administrator who is also a candidate must show the latter, or editing
    // your own profile would appear to do nothing in §10.2.
    const actorUserId = await newUser('admin');
    const bothUserId = await newUser('candidate');
    const { regionId, districtId } = await region();

    await db
      .updateTable('users')
      .set({ full_name: 'Seeded Name' })
      .where('id', '=', bothUserId)
      .execute();
    await candidates.patch(bothUserId, {
      full_name: 'Profile Name',
      date_of_birth: '1996-04-12',
      region_id: regionId,
      district_id: districtId,
      primary_occupation_id: await seededId(
        'occupation',
        'call_centre_operator',
      ),
    });

    const detail = await adminUsers.detail(actorUserId, bothUserId);

    expect(detail.name).toBe('Profile Name');
  });

  it('filters by role and status', async () => {
    const adminUserId = await newUser('admin');
    const candidateUserId = await newUser('candidate');
    await adminUsers.changeStatus(
      adminUserId,
      candidateUserId,
      'blocked',
      'Abusive messages.',
    );

    const blocked = await adminUsers.search(
      adminUserId,
      { role: 'candidate', status: 'blocked' },
      50,
      0,
    );

    expect(blocked.map((row) => row.userId)).toContain(candidateUserId);
  });

  it('warns without changing the status, so the audit row is the whole record', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    await adminUsers.warn(adminUserId, targetUserId, 'Please be civil.');

    const user = await db
      .selectFrom('users')
      .select('status')
      .where('id', '=', targetUserId)
      .executeTakeFirstOrThrow();
    expect(user.status).toBe('active');

    const [entry] = await audit.list(
      { targetType: 'user', targetId: targetUserId },
      10,
      0,
    );
    expect(entry).toMatchObject({
      action: AUDIT_ACTIONS.userWarned,
      reason: 'Please be civil.',
    });

    // No status change, therefore no `account_status_history` row: this action exists only
    // in the audit log, which is the clearest argument for having one.
    expect(
      await db
        .selectFrom('account_status_history')
        .select('id')
        .where('user_id', '=', targetUserId)
        .execute(),
    ).toEqual([]);
  });

  it('blocks with a history row and an audit row, in one transaction (UAT-14)', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    await adminUsers.changeStatus(
      adminUserId,
      targetUserId,
      'blocked',
      'Fraudulent applications.',
    );

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status', 'actor_role', 'reason'])
      .where('user_id', '=', targetUserId)
      .executeTakeFirstOrThrow();

    expect(history).toMatchObject({
      from_status: 'active',
      to_status: 'blocked',
      actor_role: 'admin',
      reason: 'Fraudulent applications.',
    });

    const [entry] = await audit.list(
      { targetType: 'user', targetId: targetUserId },
      10,
      0,
    );
    expect(entry?.action).toBe(AUDIT_ACTIONS.userBlocked);
  });

  it('refuses a status change with no reason, and one aimed at the administrator', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    await expect(
      adminUsers.changeStatus(adminUserId, targetUserId, 'blocked', '  '),
    ).rejects.toThrow(ForbiddenError);

    // Blocking yourself locks the platform's administrator out with no route back.
    await expect(
      adminUsers.changeStatus(adminUserId, adminUserId, 'blocked', 'Testing.'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a change to the status it already has', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    await expect(
      adminUsers.changeStatus(adminUserId, targetUserId, 'active', 'Nothing.'),
    ).rejects.toThrow(ConflictError);
  });

  it('shows the moderation history and the complaints about a user (§10.4)', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');
    const reporterUserId = await newUser('candidate');
    await db
      .insertInto('complaints')
      .values({
        target_type: 'user',
        target_id: targetUserId,
        reporter_user_id: reporterUserId,
        reason: 'Rude in chat.',
      })
      .execute();
    await adminUsers.changeStatus(
      adminUserId,
      targetUserId,
      'restricted',
      'Under review.',
    );

    const detail = await adminUsers.detail(adminUserId, targetUserId);

    expect(detail.status).toBe('restricted');
    expect(detail.statusHistory[0]).toMatchObject({ toStatus: 'restricted' });
    expect(detail.complaints[0]?.reason).toBe('Rude in chat.');
  });
});

describe('a temporary restriction ends by itself (§10.4)', () => {
  /** The guard's real input, reduced to what it reads. */
  function contextFor(userId: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: userId }, method: 'POST' }),
      }),
    } as unknown as ExecutionContext;
  }

  it('refuses a mutation while the restriction stands', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');
    await adminUsers.changeStatus(
      adminUserId,
      targetUserId,
      'restricted',
      'Under review.',
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(guard.canActivate(contextFor(targetUserId))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('lifts it once the end date has passed, with its BR-08 history row', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');
    await adminUsers.changeStatus(
      adminUserId,
      targetUserId,
      'restricted',
      'Under review.',
      // An hour in the past, not a second: this line is written by Node on the host and
      // compared by Postgres in its container, and those two clocks drift. The product is
      // consistent - the guard's comparison is entirely database-side - but a test that
      // straddles both needs more margin than the skew.
      new Date(Date.now() - 60 * 60 * 1000),
    );

    // No scheduler runs in this product, so the guard is where "temporary" happens - on
    // the first request after the date passes.
    await expect(guard.canActivate(contextFor(targetUserId))).resolves.toBe(
      true,
    );

    const user = await db
      .selectFrom('users')
      .select(['status', 'restricted_until'])
      .where('id', '=', targetUserId)
      .executeTakeFirstOrThrow();

    expect(user).toMatchObject({ status: 'active', restricted_until: null });

    const history = await db
      .selectFrom('account_status_history')
      .select(['from_status', 'to_status', 'actor_user_id', 'reason'])
      .where('user_id', '=', targetUserId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    // A null actor is honest: nobody decided this, the clock did.
    expect(history).toMatchObject({
      from_status: 'restricted',
      to_status: 'active',
      actor_user_id: null,
      reason: 'restriction_expired',
    });
  });

  it('keeps refusing a block, which has no end date', async () => {
    const adminUserId = await newUser('admin');
    const targetUserId = await newUser('candidate');
    await adminUsers.changeStatus(
      adminUserId,
      targetUserId,
      'blocked',
      'Fraud.',
    );

    await expect(guard.canActivate(contextFor(targetUserId))).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('§10.3 dictionary management', () => {
  async function newItem(
    adminUserId: string,
    labels: Record<string, string>,
  ): Promise<string> {
    const id = await adminDictionaries.create(adminUserId, 'skill', {
      code: `test_${randomUUID().slice(0, 8)}`,
      labels,
    });
    createdItems.push(id);

    return id;
  }

  it('creates an inactive item, and refuses to activate it until all four labels exist', async () => {
    const adminUserId = await newUser('admin');
    const itemId = await newItem(adminUserId, {
      'uz-Latn': 'Sinov',
      'uz-Cyrl': 'Синов',
      ru: 'Тест',
    });

    const created = await db
      .selectFrom('dictionary_items')
      .select('is_active')
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(created.is_active).toBe(false);

    // The four-locale rule is a deferrable constraint trigger, not a service check - so it
    // holds against every write path, including this one.
    await expect(
      adminDictionaries.setActive(adminUserId, itemId, true),
    ).rejects.toThrow();

    await adminDictionaries.update(adminUserId, itemId, {
      labels: { en: 'Test' },
    });
    await adminDictionaries.setActive(adminUserId, itemId, true);

    expect(
      (
        await db
          .selectFrom('dictionary_items')
          .select('is_active')
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow()
      ).is_active,
    ).toBe(true);
  });

  it('bumps the revision on every write, so clients learn of the change', async () => {
    const adminUserId = await newUser('admin');
    const itemId = await newItem(adminUserId, {
      'uz-Latn': 'Sinov',
      'uz-Cyrl': 'Синов',
      ru: 'Тест',
      en: 'Test',
    });
    const before = await dictionariesRead.typeVersion('skill');

    await adminDictionaries.update(adminUserId, itemId, {
      labels: { en: 'Test skill' },
    });

    // The version a client polls, not the item's own column: a label change bumps the
    // translation row, and the type's version is the highest revision in either table.
    // Asserting the client-visible number is what proves the cache will refetch.
    expect(await dictionariesRead.typeVersion('skill')).toBeGreaterThan(before);
  });

  it('refuses a duplicate code within a type', async () => {
    const adminUserId = await newUser('admin');
    const code = `test_${randomUUID().slice(0, 8)}`;
    const labels = {
      'uz-Latn': 'Sinov',
      'uz-Cyrl': 'Синов',
      ru: 'Тест',
      en: 'Test',
    };
    const id = await adminDictionaries.create(adminUserId, 'skill', {
      code,
      labels,
    });
    createdItems.push(id);

    await expect(
      adminDictionaries.create(adminUserId, 'skill', { code, labels }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses an unknown type', async () => {
    const adminUserId = await newUser('admin');

    await expect(
      adminDictionaries.create(adminUserId, 'not_a_type', {
        code: 'x',
        labels: {},
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('merges a duplicate into a survivor, leaving it resolvable (§10.3)', async () => {
    const adminUserId = await newUser('admin');
    const labels = {
      'uz-Latn': 'Sinov',
      'uz-Cyrl': 'Синов',
      ru: 'Тест',
      en: 'Test',
    };
    const loserId = await newItem(adminUserId, labels);
    const survivorId = await newItem(adminUserId, labels);

    await adminDictionaries.merge(adminUserId, loserId, survivorId);

    const loser = await db
      .selectFrom('dictionary_items')
      .select(['is_active', 'merged_into_id'])
      .where('id', '=', loserId)
      .executeTakeFirstOrThrow();

    // Deactivated and pointing at the survivor: every profile that referenced it still
    // resolves, which is what `GET /dictionaries/items?ids=` relies on.
    expect(loser).toMatchObject({
      is_active: false,
      merged_into_id: survivorId,
    });

    const [entry] = await audit.list(
      { targetType: 'dictionary_item', targetId: loserId },
      10,
      0,
    );
    expect(entry?.action).toBe(AUDIT_ACTIONS.dictionaryItemsMerged);
  });

  it('refuses a merge into itself, across types, or into an already merged item', async () => {
    const adminUserId = await newUser('admin');
    const labels = {
      'uz-Latn': 'Sinov',
      'uz-Cyrl': 'Синов',
      ru: 'Тест',
      en: 'Test',
    };
    const first = await newItem(adminUserId, labels);
    const second = await newItem(adminUserId, labels);
    const industry = await adminDictionaries.create(adminUserId, 'industry', {
      code: `test_${randomUUID().slice(0, 8)}`,
      labels,
    });
    createdItems.push(industry);

    await expect(
      adminDictionaries.merge(adminUserId, first, first),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      adminDictionaries.merge(adminUserId, first, industry),
    ).rejects.toThrow(ForbiddenError);

    await adminDictionaries.merge(adminUserId, first, second);
    const third = await newItem(adminUserId, labels);

    // Merging into something already merged would build a chain readers have to walk.
    await expect(
      adminDictionaries.merge(adminUserId, third, first),
    ).rejects.toThrow(ConflictError);
  });
});

describe('§10.4 the audit log as a read', () => {
  it('answers "what has this administrator done"', async () => {
    const adminUserId = await newUser('admin');
    const first = await newUser('candidate');
    const second = await newUser('candidate');
    await adminUsers.warn(adminUserId, first, 'One.');
    await adminUsers.warn(adminUserId, second, 'Two.');

    const entries = await audit.list({ actorUserId: adminUserId }, 10, 0);

    expect(entries).toHaveLength(2);
    // Newest first: an audit log is read backwards from the thing that just happened.
    expect(entries[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      entries[1].createdAt.getTime(),
    );
  });

  it('answers "what was done to this user"', async () => {
    const firstAdmin = await newUser('admin');
    const secondAdmin = await newUser('admin');
    const targetUserId = await newUser('candidate');
    await adminUsers.warn(firstAdmin, targetUserId, 'A warning.');
    await adminUsers.changeStatus(
      secondAdmin,
      targetUserId,
      'restricted',
      'A restriction.',
    );

    const entries = await audit.list(
      { targetType: 'user', targetId: targetUserId },
      10,
      0,
    );

    expect(entries.map((entry) => entry.action)).toEqual([
      AUDIT_ACTIONS.userRestricted,
      AUDIT_ACTIONS.userWarned,
    ]);
  });
});
