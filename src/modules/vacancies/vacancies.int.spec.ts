import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';

import { AUTO_APPROVED_REASON } from './vacancy-status';
import { VacanciesService } from './vacancies.service';

/**
 * Integration tests against a real Postgres.
 *
 * Run with `pnpm test:int`. The status machine writes two tables per transition, the
 * timestamp columns are governed by CHECK constraints, BR-05 and BR-12 are CHECKs, and
 * the requirements table's "exactly one value" rule is one too. Over `DummyDriver`
 * every one of these would compile, run nothing, and pass.
 *
 * The service is built twice, once per `MODERATION_ENABLED` value, because the flag
 * decides whether a submission queues or publishes - and because the interesting case
 * is a BR-12 restriction, which must queue either way.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
/** Moderation off - the MVP configuration. */
let autoPublish: VacanciesService;
/** Moderation on - what M10 turns on. */
let moderated: VacanciesService;

const users: string[] = [];

function config(moderationEnabled: boolean): ConfigService<AppEnv, true> {
  return {
    get: (key: string) =>
      key === 'MODERATION_ENABLED'
        ? moderationEnabled
        : key === 'EMPLOYER_VERIFICATION_ENABLED'
          ? false
          : key === 'PLATFORM_TIME_ZONE'
            ? 'Asia/Tashkent'
            : key === 'FILE_MAX_SIZE_BYTES'
              ? 10_485_760
              : undefined,
  } as unknown as ConfigService<AppEnv, true>;
}

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());

  const dictionaries = new DictionariesService(db);
  const schemas = new SchemasService(db, dictionaries, config(false));
  const validator = new FieldValidatorService(dictionaries, config(false));
  employers = new EmployersService(db);

  autoPublish = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    config(false),
  );
  moderated = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    config(true),
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

async function anyActive(
  type: string,
  where: (code: string) => boolean = () => true,
): Promise<string> {
  const rows = await db
    .selectFrom('dictionary_items')
    .select(['id', 'code'])
    .where('type_code', '=', type)
    .where('is_active', '=', true)
    .execute();

  const row = rows.find((candidate) => where(candidate.code));

  if (!row) {
    throw new Error(`No seeded ${type} matched`);
  }

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

/** A verified employer, which BR-03 requires before any vacancy exists. */
async function verifiedEmployer(): Promise<string> {
  const phone = `+99897${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('user_roles')
    .values({ user_id: row.id, role: 'employer' })
    .execute();

  users.push(row.id);

  const { regionId } = await region();
  await employers.upsert(row.id, 'company', {
    contactPhone: '+998901234567',
    regionId,
    legalName: 'Uzum Market LLC',
    publicName: 'Uzum',
    industryId: await anyActive('industry'),
    contactPersonName: 'Anvar Karimov',
    description: 'Marketplace operator hiring call-centre staff.',
  });

  const verification = new VerificationService(db, employers, config(false));
  const purpose = await seededId('file_purpose', 'company_registration');
  const unique = randomUUID();
  const file = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: row.id,
      purpose_id: purpose,
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

  await verification.submit(row.id, [file.id]);

  return row.id;
}

/** Everything a professional vacancy needs to be submittable. */
async function completeFields(): Promise<Record<string, unknown>> {
  const { regionId, districtId } = await region();

  return {
    occupation_id: await seededId('occupation', 'software_developer'),
    title: 'Backend developer',
    description:
      'Build and maintain the marketplace API. Postgres, Node, and a lot of care.',
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
  };
}

describe('VacanciesService', () => {
  it('refuses to create a vacancy for an unverified employer (BR-03)', async () => {
    const phone = `+99897${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
    const row = await db
      .insertInto('users')
      .values({ phone, locale: 'uz-Latn' })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(row.id);

    await expect(autoPublish.create(row.id)).rejects.toThrow(ForbiddenError);
  });

  it('creates a draft and records its first history row', async () => {
    const employer = await verifiedEmployer();
    const vacancy = await autoPublish.create(employer);

    expect(vacancy.aggregate.row.status).toBe('draft');
    expect(vacancy.missingForSubmit.length).toBeGreaterThan(0);

    const history = await db
      .selectFrom('vacancy_status_history')
      .select(['from_status', 'to_status'])
      .where('vacancy_id', '=', vacancy.aggregate.row.id)
      .execute();

    expect(history).toEqual([{ from_status: null, to_status: 'draft' }]);
  });

  it('derives the category from the occupation', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const cotton = await anyActive('occupation', (code) =>
      code.includes('cotton'),
    );

    const patched = await autoPublish.patch(employer, draft.aggregate.row.id, {
      occupation_id: cotton,
    });

    expect(patched.aggregate.row.category).toBe('seasonal_agricultural');
  });

  it('refuses a category field the vacancy’s category does not have', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(employer, draft.aggregate.row.id, {
      occupation_id: await seededId('occupation', 'software_developer'),
    });

    // `crew_required` exists for physical and seasonal work only.
    await expect(
      autoPublish.patch(employer, draft.aggregate.row.id, {
        crew_required: true,
      }),
    ).rejects.toThrow(ValidationFailedException);
  });

  it('stores a leveled requirement with its rank and mandatory flag (§6.3)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');

    const patched = await autoPublish.patch(employer, draft.aggregate.row.id, {
      languages: [{ itemId: russian, levelId: c1, is_mandatory: true }],
    });

    expect(patched.fields.languages).toEqual([
      { itemId: russian, levelId: c1, is_mandatory: true },
    ]);

    const row = await db
      .selectFrom('vacancy_requirements')
      .selectAll()
      .where('vacancy_id', '=', draft.aggregate.row.id)
      .where('field_code', '=', 'languages')
      .executeTakeFirstOrThrow();

    // §7.4's controlled example is "Russian at C1", so the rank must be comparable
    // without another join.
    expect(row.level_rank).toBeGreaterThan(0);
    expect(row.is_mandatory).toBe(true);
  });

  it('treats a requirement stated without a flag as mandatory', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);

    await autoPublish.patch(employer, draft.aggregate.row.id, {
      skills: [
        {
          itemId: await seededId('skill', 'typescript'),
          levelId: await anyActive('skill_level'),
        },
      ],
    });

    const row = await db
      .selectFrom('vacancy_requirements')
      .select('is_mandatory')
      .where('vacancy_id', '=', draft.aggregate.row.id)
      .where('field_code', '=', 'skills')
      .executeTakeFirstOrThrow();

    expect(row.is_mandatory).toBe(true);
  });

  it('refuses BR-05’s worker count below one', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);

    await expect(
      autoPublish.patch(employer, draft.aggregate.row.id, { worker_count: 0 }),
    ).rejects.toThrow(ValidationFailedException);
  });

  it('refuses to submit while a required field is unfilled, one violation per field', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(employer, draft.aggregate.row.id, {
      title: 'Backend developer',
    });

    const error = await autoPublish
      .submit(employer, draft.aggregate.row.id)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationFailedException);
    // The client focuses each unfilled field rather than guessing from one message.
    expect(
      (error as ValidationFailedException).violations.map((v) => v.field),
    ).toContain('occupation_id');
  });

  it('publishes immediately while moderation is off, and records that honestly', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(
      employer,
      draft.aggregate.row.id,
      await completeFields(),
    );

    const submitted = await autoPublish.submit(
      employer,
      draft.aggregate.row.id,
    );

    expect(submitted.aggregate.row.status).toBe('active');
    expect(submitted.aggregate.row.published_at).not.toBeNull();
    expect(submitted.isOpenForApplications).toBe(true);

    const history = await db
      .selectFrom('vacancy_status_history')
      .select(['from_status', 'to_status', 'actor_user_id', 'reason'])
      .where('vacancy_id', '=', draft.aggregate.row.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    // BR-08 without a lie: the row says a rule published this, not a person.
    expect(history).toMatchObject({
      from_status: 'draft',
      to_status: 'active',
      reason: AUTO_APPROVED_REASON,
    });
  });

  it('queues for moderation when the flag is on (BR-04)', async () => {
    const employer = await verifiedEmployer();
    const draft = await moderated.create(employer);
    await moderated.patch(
      employer,
      draft.aggregate.row.id,
      await completeFields(),
    );

    const submitted = await moderated.submit(employer, draft.aggregate.row.id);

    expect(submitted.aggregate.row.status).toBe('under_moderation');
    // BR-04: not visible until approved, so not open for applications either.
    expect(submitted.isOpenForApplications).toBe(false);
    expect(submitted.aggregate.row.published_at).toBeNull();
  });

  it('sends a BR-12 restricted vacancy to review even with moderation off', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(employer, draft.aggregate.row.id, {
      ...(await completeFields()),
      age_min: 18,
      restriction_justification_id: await seededId(
        'restriction_justification',
        'night_work_restriction',
      ),
    });

    const submitted = await autoPublish.submit(
      employer,
      draft.aggregate.row.id,
    );

    // The flag exists so ordinary vacancies are not stranded without a moderator, not
    // so a restriction can skip the review BR-12 requires for it.
    expect(submitted.aggregate.row.status).toBe('under_moderation');
  });

  it('refuses a restriction whose justification does not support it (BR-12)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(employer, draft.aggregate.row.id, {
      ...(await completeFields()),
      gender_id: await seededId('gender', 'female'),
      // A minimum-age rule cannot justify a gender restriction.
      restriction_justification_id: await seededId(
        'restriction_justification',
        'statutory_minimum_age',
      ),
    });

    await expect(
      autoPublish.submit(employer, draft.aggregate.row.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a restriction with no justification at all, in the database', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);

    // The CHECK constraint, not the service: an admin path or a manual SQL fix must
    // not be able to write a restriction with no stated reason either.
    await expect(
      db
        .updateTable('vacancies')
        .set({ age_min: 21 })
        .where('id', '=', draft.aggregate.row.id)
        .execute(),
    ).rejects.toThrow();
  });

  it('refuses to publish with a deadline already past', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    await autoPublish.patch(employer, draft.aggregate.row.id, {
      ...(await completeFields()),
      deadline_on: '2020-01-01',
    });

    // BR-06 would refuse every application to it, so publishing is pointless.
    await expect(
      autoPublish.submit(employer, draft.aggregate.row.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it('walks reject → edit → draft → resubmit, keeping every history row', async () => {
    const employer = await verifiedEmployer();
    const admin = await verifiedEmployer();
    const draft = await moderated.create(employer);
    const id = draft.aggregate.row.id;
    await moderated.patch(employer, id, await completeFields());
    await moderated.submit(employer, id);

    const rejected = await moderated.moderate(
      id,
      'rejected',
      { userId: admin, role: 'admin' },
      'The description does not say what the work involves.',
    );
    expect(rejected.aggregate.row.status).toBe('rejected');
    expect(rejected.aggregate.row.moderation_reason).toContain('description');

    // Editing a rejected vacancy makes it a draft again, and clears the stale reason.
    const edited = await moderated.patch(employer, id, {
      description:
        'Build and maintain the marketplace API, on call one week in four.',
    });
    expect(edited.aggregate.row.status).toBe('draft');
    expect(edited.aggregate.row.moderation_reason).toBeNull();

    const resubmitted = await moderated.submit(employer, id);
    expect(resubmitted.aggregate.row.status).toBe('under_moderation');

    const approved = await moderated.moderate(
      id,
      'active',
      { userId: admin, role: 'admin' },
      null,
    );
    expect(approved.aggregate.row.status).toBe('active');

    const history = await db
      .selectFrom('vacancy_status_history')
      .select('to_status')
      .where('vacancy_id', '=', id)
      .orderBy('created_at')
      .execute();

    expect(history.map((row) => row.to_status)).toEqual([
      'draft',
      'under_moderation',
      'rejected',
      'draft',
      'under_moderation',
      'active',
    ]);
  });

  it('requires a reason to reject (§6.4)', async () => {
    const employer = await verifiedEmployer();
    const admin = await verifiedEmployer();
    const draft = await moderated.create(employer);
    await moderated.patch(
      employer,
      draft.aggregate.row.id,
      await completeFields(),
    );
    await moderated.submit(employer, draft.aggregate.row.id);

    await expect(
      moderated.moderate(
        draft.aggregate.row.id,
        'rejected',
        { userId: admin, role: 'admin' },
        '   ',
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses to edit a vacancy that is under review', async () => {
    const employer = await verifiedEmployer();
    const draft = await moderated.create(employer);
    await moderated.patch(
      employer,
      draft.aggregate.row.id,
      await completeFields(),
    );
    await moderated.submit(employer, draft.aggregate.row.id);

    // A moderator is reading it; an edit would have them approve something else.
    await expect(
      moderated.patch(employer, draft.aggregate.row.id, { title: 'Changed' }),
    ).rejects.toThrow(ConflictError);
  });

  it('sends a live vacancy back for review when its restriction changes (BR-12)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());
    await autoPublish.submit(employer, id);

    const restricted = await autoPublish.patch(employer, id, {
      age_min: 18,
      restriction_justification_id: await seededId(
        'restriction_justification',
        'night_work_restriction',
      ),
    });

    // It has not been reviewed as it now reads, so it leaves discovery until it is.
    expect(restricted.aggregate.row.status).toBe('under_moderation');
    expect(restricted.isOpenForApplications).toBe(false);
  });

  it('leaves a live vacancy live for an ordinary edit', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());
    await autoPublish.submit(employer, id);

    const edited = await autoPublish.patch(employer, id, {
      title: 'Senior backend developer',
    });

    expect(edited.aggregate.row.status).toBe('active');
  });

  it('pauses and resumes without moving published_at (§5.5)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());
    const published = await autoPublish.submit(employer, id);
    const publishedAt = published.aggregate.row.published_at;

    const paused = await autoPublish.changeStatus(employer, id, 'paused', null);
    expect(paused.aggregate.row.status).toBe('paused');
    expect(paused.isOpenForApplications).toBe(false);

    const resumed = await autoPublish.changeStatus(
      employer,
      id,
      'active',
      null,
    );
    // Discovery sorts by publication time; a pause must not make an old vacancy new.
    expect(resumed.aggregate.row.published_at).toEqual(publishedAt);
  });

  it('closes with a reason and stays in history (BR-11)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());
    await autoPublish.submit(employer, id);

    const closed = await autoPublish.changeStatus(
      employer,
      id,
      'closed',
      'All three positions filled.',
    );

    expect(closed.aggregate.row.status).toBe('closed');
    expect(closed.aggregate.row.closed_at).not.toBeNull();
    expect(closed.aggregate.row.closure_reason).toBe(
      'All three positions filled.',
    );
    expect(closed.isOpenForApplications).toBe(false);

    // Retained in the employer's own list, which is what BR-11 means by history.
    const mine = await autoPublish.listMine(employer);
    expect(mine.map((item) => item.aggregate.row.id)).toContain(id);
  });

  it('refuses every transition out of closed (BR-11)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());
    await autoPublish.submit(employer, id);
    await autoPublish.changeStatus(employer, id, 'closed', 'Filled.');

    await expect(
      autoPublish.changeStatus(employer, id, 'active', null),
    ).rejects.toThrow(ConflictError);
    await expect(
      autoPublish.patch(employer, id, { title: 'Reopened' }),
    ).rejects.toThrow(ConflictError);
  });

  it('never shows one employer another’s vacancy', async () => {
    const owner = await verifiedEmployer();
    const other = await verifiedEmployer();
    const draft = await autoPublish.create(owner);

    // 404, not 403: confirming the id exists is information we do not owe (§11.1).
    await expect(
      autoPublish.read(other, draft.aggregate.row.id),
    ).rejects.toThrow(NotFoundError);
    await expect(
      autoPublish.patch(other, draft.aggregate.row.id, { title: 'Hijacked' }),
    ).rejects.toThrow(NotFoundError);
    await expect(autoPublish.listMine(other)).resolves.toEqual([]);
  });

  it('supports §7.5’s seasonal shape end to end (UAT-10)', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    const { regionId, districtId } = await region();

    // The controlled example: work type, region, date range, worker count, working
    // hours, transport conditions, crew readiness and a payment method.
    const patched = await autoPublish.patch(employer, id, {
      occupation_id: await anyActive('occupation', (code) =>
        code.includes('cotton'),
      ),
      title: 'Cotton planting, one hectare',
      description:
        'Planting one hectare of cotton. Transport from the district centre provided.',
      worker_count: 12,
      region_id: regionId,
      district_id: districtId,
      employment_type_ids: [
        await seededId('employment_type', 'seasonal'),
      ].filter(Boolean),
      salary: {
        from: 150_000,
        to: null,
        periodId: await seededId('payment_period', 'daily'),
        isNegotiable: false,
      },
      starts_on: '2026-09-01',
      ends_on: '2026-09-14',
      hours_per_day: 8,
      transport_ids: [await seededId('attribute', 'own_car')],
      tool_ids: [await seededId('attribute', 'hand_tools')],
      crew_required: true,
    });

    expect(patched.aggregate.row.category).toBe('seasonal_agricultural');
    expect(patched.fields.crew_required).toBe(true);
    expect(patched.fields.hours_per_day).toBe(8);
    expect(patched.missingForSubmit).toEqual([]);

    const submitted = await autoPublish.submit(employer, id);
    expect(submitted.aggregate.row.status).toBe('active');
  });

  it('removes vacancies and their history with the employer', async () => {
    const employer = await verifiedEmployer();
    const draft = await autoPublish.create(employer);
    const id = draft.aggregate.row.id;
    await autoPublish.patch(employer, id, await completeFields());

    await db.deleteFrom('employers').where('user_id', '=', employer).execute();

    for (const table of [
      'vacancies',
      'vacancy_requirements',
      'vacancy_status_history',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();

      expect(
        rows.filter((row) =>
          'id' in row ? row.id === id : row.vacancy_id === id,
        ),
      ).toHaveLength(0);
    }
  });
});
