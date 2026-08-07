import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import type { EmployerType } from '@infra/db/database.types';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';

import { EMPLOYER_REQUIREMENTS } from './employer-requirements';
import { EmployersService } from './employers.service';
import {
  AUTO_VERIFIED_REASON,
  VerificationService,
} from './verification.service';

/**
 * Integration tests against a real Postgres.
 *
 * Run with `pnpm test:int`. None of this is unit-testable: the verification machine
 * writes two tables per transition, `verified_at` agreeing with the status is a CHECK,
 * one open submission per employer is a partial unique index, and BR-03's gate is a
 * stored column recomputed from a requirement list.
 *
 * The service is constructed twice, once per `EMPLOYER_VERIFICATION_ENABLED` value,
 * because the flag decides whether a submission queues or self-approves and both
 * paths have to hold.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
/** Review off - the MVP configuration. */
let autoVerify: VerificationService;
/** Review on - what M10 turns on. */
let queued: VerificationService;

const users: string[] = [];

function config(reviewEnabled: boolean): ConfigService<AppEnv, true> {
  return {
    get: (key: string) =>
      key === 'EMPLOYER_VERIFICATION_ENABLED'
        ? reviewEnabled
        : key === 'PLATFORM_TIME_ZONE'
          ? 'Asia/Tashkent'
          : undefined,
  } as unknown as ConfigService<AppEnv, true>;
}

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  employers = new EmployersService(db);
  autoVerify = new VerificationService(db, employers, config(false));
  queued = new VerificationService(db, employers, config(true));
});

afterAll(async () => {
  // Order matters, and it is the same order a BR-14 purge will have to use: the
  // employer row first, which cascades its submissions and their file links, then
  // the files, then the user. `verification_submission_files.file_id` is RESTRICT on
  // purpose - evidence must not vanish from under a submission an administrator is
  // reading - so deleting a user's files while a submission still references them
  // fails, which is what this cleanup originally did.
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

async function newEmployer(): Promise<string> {
  const phone = `+99895${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
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
  return row.id;
}

async function seededId(type: string, code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function anyRegion(): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'region')
    .where('parent_id', 'is', null)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return row.id;
}

/**
 * A stored-file row, without going through Telegram.
 *
 * The upload path is covered by `infra/files`; what matters here is that a
 * submission checks ownership and purpose, which are database facts.
 */
async function storedFile(
  ownerUserId: string,
  purposeCode: string,
): Promise<string> {
  const purpose = await seededId('file_purpose', purposeCode);
  const unique = randomUUID();
  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: purpose,
      telegram_file_id: `fake-${unique}`,
      telegram_file_unique_id: unique,
      telegram_message_id: '1',
      file_name: `${purposeCode}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: 128,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/** Everything §6.1 requires, so BR-03's gate can be reached. */
async function completeInput(type: EmployerType) {
  const region = await anyRegion();

  return type === 'company'
    ? {
        contactPhone: '+998901234567',
        regionId: region,
        legalName: 'Uzum Market LLC',
        publicName: 'Uzum',
        industryId: await seededId('industry', 'retail').catch(async () => {
          const row = await db
            .selectFrom('dictionary_items')
            .select('id')
            .where('type_code', '=', 'industry')
            .where('is_active', '=', true)
            .executeTakeFirstOrThrow();
          return row.id;
        }),
        contactPersonName: 'Anvar Karimov',
        description: 'Marketplace operator hiring call-centre staff.',
      }
    : {
        contactPhone: '+998901234567',
        regionId: region,
        fullName: 'Anvar Karimov',
        description: 'Need four workers for cotton planting for two weeks.',
      };
}

describe('EmployersService', () => {
  it('reports no profile as not found rather than inventing an empty one', async () => {
    const userId = await newEmployer();

    // Unlike a candidate profile: `type` decides which fields exist, so there is no
    // neutral empty employer to render.
    await expect(employers.findMine(userId)).rejects.toThrow(NotFoundError);
  });

  it('creates a company profile and stores its completeness', async () => {
    const userId = await newEmployer();
    const profile = await employers.upsert(
      userId,
      'company',
      await completeInput('company'),
    );

    expect(profile.type).toBe('company');
    expect(profile.isComplete).toBe(true);
    expect(profile.completenessPercent).toBe(100);

    const row = await db
      .selectFrom('employers')
      .select(['is_complete', 'completeness_percent', 'verification_status'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(row.is_complete).toBe(true);
    expect(row.verification_status).toBe('not_submitted');
  });

  it('measures completeness against the requirements of that type only', async () => {
    const userId = await newEmployer();
    // A legal name is required of a company and meaningless for an individual, so
    // the same input completes one and not the other.
    const profile = await employers.upsert(userId, 'individual', {
      contactPhone: '+998901234567',
      regionId: await anyRegion(),
      fullName: 'Anvar Karimov',
      description: 'Need four workers for two weeks.',
    });

    expect(profile.isComplete).toBe(true);
    expect(EMPLOYER_REQUIREMENTS.individual.fields.length).toBeLessThan(
      EMPLOYER_REQUIREMENTS.company.fields.length,
    );
  });

  it('lists the missing required fields for the client’s prompts', async () => {
    const userId = await newEmployer();
    const profile = await employers.upsert(userId, 'company', {
      contactPhone: '+998901234567',
    });

    const missing = employers.missingFields(profile).map((item) => item.field);

    expect(profile.isComplete).toBe(false);
    expect(missing).toContain('legalName');
    expect(missing).toContain('industryId');
    expect(missing).not.toContain('contactPhone');
  });

  it('refuses to change the employer type after creation', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));

    // Changing it would strand the other type's answers, and the verification was
    // granted against one type's evidence rules.
    await expect(
      employers.upsert(userId, 'individual', { fullName: 'Anvar' }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('keeps company detail out of an individual employer’s row', async () => {
    const userId = await newEmployer();
    await employers.upsert(
      userId,
      'individual',
      await completeInput('individual'),
    );

    const rows = await db
      .selectFrom('companies')
      .select('employer_user_id')
      .where('employer_user_id', '=', userId)
      .execute();

    expect(rows).toHaveLength(0);
  });

  it('answers BR-03’s gate with both conditions separately', async () => {
    const userId = await newEmployer();

    expect(await employers.gate(userId)).toEqual({
      isComplete: false,
      isVerified: false,
    });

    await employers.upsert(userId, 'company', await completeInput('company'));
    expect(await employers.gate(userId)).toEqual({
      isComplete: true,
      isVerified: false,
    });

    // "Finish your profile" and "wait for verification" are different refusals.
    await expect(employers.assertVerified(userId)).rejects.toThrow(
      ForbiddenError,
    );

    await autoVerify.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    expect(await employers.gate(userId)).toEqual({
      isComplete: true,
      isVerified: true,
    });
    await expect(employers.assertVerified(userId)).resolves.toBeUndefined();
  });
});

describe('VerificationService', () => {
  it('refuses a submission from an incomplete profile', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', {
      contactPhone: '+998901234567',
    });

    await expect(
      autoVerify.submit(userId, [
        await storedFile(userId, 'company_registration'),
      ]),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a company submission without the required document', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));

    await expect(autoVerify.submit(userId, [])).rejects.toThrow(ForbiddenError);

    // Nothing was written: no submission row, and the status is untouched.
    const rows = await db
      .selectFrom('verification_submissions')
      .select('id')
      .where('employer_user_id', '=', userId)
      .execute();

    expect(rows).toHaveLength(0);
    expect((await employers.findMine(userId)).verificationStatus).toBe(
      'not_submitted',
    );
  });

  it('accepts an individual submission with no document, per the declared default', async () => {
    const userId = await newEmployer();
    await employers.upsert(
      userId,
      'individual',
      await completeInput('individual'),
    );

    // §6.1's "if required by policy" is still open, and the declared default is
    // optional for an individual. This test pins the current answer so flipping it
    // is a deliberate change, not a surprise.
    const state = await autoVerify.submit(userId, []);

    expect(state.status).toBe('verified');
  });

  it('never lets an employer submit another account’s file', async () => {
    const owner = await newEmployer();
    const attacker = await newEmployer();
    await employers.upsert(attacker, 'company', await completeInput('company'));
    const someoneElses = await storedFile(owner, 'company_registration');

    // Otherwise an administrator would be reviewing a document belonging to a
    // different account.
    await expect(autoVerify.submit(attacker, [someoneElses])).rejects.toThrow(
      NotFoundError,
    );
  });

  it('auto-verifies while review is off, and records that honestly (BR-08)', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));

    const state = await autoVerify.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    expect(state.status).toBe('verified');
    expect(state.verifiedAt).not.toBeNull();

    const history = await db
      .selectFrom('employer_verification_history')
      .select(['from_status', 'to_status', 'actor_user_id', 'reason'])
      .where('employer_user_id', '=', userId)
      .execute();

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: 'not_submitted',
      to_status: 'verified',
      // A null actor and a named reason: the history must never imply a person
      // reviewed this.
      actor_user_id: null,
      reason: AUTO_VERIFIED_REASON,
    });
  });

  it('queues for review when the flag is on', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));

    const state = await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    expect(state.status).toBe('under_review');
    expect(state.verifiedAt).toBeNull();
    // BR-03 still blocks: an employer under review may not publish.
    expect(await employers.gate(userId)).toEqual({
      isComplete: true,
      isVerified: false,
    });
  });

  it('allows only one open submission at a time', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    // A partial unique index backs this up, but the status check refuses first with
    // a message the client can act on.
    await expect(
      queued.submit(userId, [await storedFile(userId, 'company_registration')]),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses to submit again once verified', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await autoVerify.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    await expect(
      autoVerify.submit(userId, [
        await storedFile(userId, 'company_registration'),
      ]),
    ).rejects.toThrow(ConflictError);
  });

  it('records a rejection with its reason and clears verified_at', async () => {
    const userId = await newEmployer();
    const admin = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    const state = await queued.decide(
      userId,
      'rejected',
      { userId: admin, role: 'admin' },
      'The registration certificate is illegible.',
    );

    expect(state.status).toBe('rejected');
    expect(state.reason).toBe('The registration certificate is illegible.');
    expect(state.verifiedAt).toBeNull();
    expect(state.submissions[0].decidedAt).not.toBeNull();

    const history = await db
      .selectFrom('employer_verification_history')
      .select(['to_status', 'actor_user_id', 'actor_role'])
      .where('employer_user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();

    expect(history[0]).toMatchObject({
      to_status: 'rejected',
      actor_user_id: admin,
      actor_role: 'admin',
    });
  });

  it('requires a reason for anything other than an approval (§6.1)', async () => {
    const userId = await newEmployer();
    const admin = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    // A refusal the employer cannot act on is not a decision.
    await expect(
      queued.decide(
        userId,
        'changes_required',
        { userId: admin, role: 'admin' },
        '  ',
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('lets an employer resubmit after changes are requested', async () => {
    const userId = await newEmployer();
    const admin = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);
    await queued.decide(
      userId,
      'changes_required',
      { userId: admin, role: 'admin' },
      'Please upload a clearer scan.',
    );

    const state = await queued.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    expect(state.status).toBe('under_review');
    // Both attempts are kept: an administrator reviewing a resubmission needs to see
    // what was sent before and why it was refused.
    expect(state.submissions).toHaveLength(2);

    const history = await db
      .selectFrom('employer_verification_history')
      .select('to_status')
      .where('employer_user_id', '=', userId)
      .execute();

    expect(history).toHaveLength(3);
  });

  it('refuses a decision on an employer who has not submitted', async () => {
    const userId = await newEmployer();
    const admin = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));

    await expect(
      queued.decide(userId, 'verified', { userId: admin, role: 'admin' }, null),
    ).rejects.toThrow(ConflictError);
  });

  it('serves the required evidence list rather than making the client hardcode it', async () => {
    const userId = await newEmployer();
    await employers.upsert(
      userId,
      'individual',
      await completeInput('individual'),
    );

    const state = await autoVerify.state(userId);

    expect(state.requiredEvidence).toEqual([
      { purposeCode: 'id_document', required: false },
    ]);
  });

  it('removes the profile, submissions and history with the account', async () => {
    const userId = await newEmployer();
    await employers.upsert(userId, 'company', await completeInput('company'));
    await autoVerify.submit(userId, [
      await storedFile(userId, 'company_registration'),
    ]);

    // stored_files first: verification_submission_files references them with
    // RESTRICT, which is deliberate - evidence must not vanish from under a
    // submission an administrator is reading.
    await db.deleteFrom('employers').where('user_id', '=', userId).execute();

    for (const table of [
      'verification_submissions',
      'employer_verification_history',
    ] as const) {
      const rows = await db
        .selectFrom(table)
        .select('id')
        .where('employer_user_id', '=', userId)
        .execute();

      expect(rows).toHaveLength(0);
    }
  });
});
