import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { ChatService } from '@modules/chat/chat.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { WalletService } from '@modules/wallet/wallet.service';

import { ApplicationsService } from './applications.service';
import { CandidateViewService } from './candidate-view.service';

/**
 * The Candidate Unlock as an entitlement (§6.6, §11.1, BR-17, UAT-17..19).
 *
 * M12 built the purchase; this is what reads it. Until it existed an employer could pay two
 * Coins and see exactly what they saw before, because `expose()` did not know an unlock
 * existed and `candidate_unlocks` was referenced only inside the wallet module.
 *
 * The rule itself is unit-tested in `infra/privacy/contact-exposure.spec.ts`, which is where
 * every combination is enumerated. What can only be tested here is the **plumbing**: that
 * `between()` finds the row, that the precedence between three real entitlements is what the
 * rule was given, that the download path a client is handed actually serves bytes, and that a
 * purchase cannot be made by someone §7 will then refuse.
 *
 * **The reading this suite encodes:** an application is one of §11.1's "explicitly approved
 * entitlements", so the unlock is for candidates who have *not* applied. §9.1 read strictly
 * says otherwise, and that is a client decision recorded in ARCHITECTURE.md §13 - not
 * something to infer from these tests.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let verification: VerificationService;
let candidates: CandidatesService;
let vacancies: VacanciesService;
let applications: ApplicationsService;
let invitations: InvitationsService;
let candidateView: CandidateViewService;
let interactions: HiringInteractionService;
let wallet: WalletService;
let chat: ChatService;
let notifications: NotificationsService;

const users: string[] = [];

const config = {
  get: (key: string) =>
    ({
      PLATFORM_TIME_ZONE: 'Asia/Tashkent',
      // Both flags off, as the other module suites run them: a submission then self-approves
      // with a null actor instead of waiting for an administrator, so `newEmployer()` produces
      // a verified employer without wiring M10 in. What is under test here is §7's *gate*, and
      // `newEmployer(false)` exercises the refusing side of it.
      MODERATION_ENABLED: false,
      EMPLOYER_VERIFICATION_ENABLED: false,
      SEARCH_COUNT_CAP: 200,
      COIN_PRICE_UZS: 10_000,
      CANDIDATE_UNLOCK_COINS: 2,
      EMPLOYER_REGISTRATION_BONUS_COINS: 10,
    })[key],
} as unknown as ConfigService<AppEnv, true>;

/**
 * Telegram stands in for itself: these tests are about *who may read a file*, which is this
 * API's rule, not about whether Telegram returns bytes (`files.int.spec.ts` covers that).
 */
const filesStub = {
  readAsAuthorized: (ownerUserId: string, fileId: string) =>
    Promise.resolve({
      file: {
        id: fileId,
        purposeId: 'p',
        fileName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4,
        createdAt: new Date(),
      },
      bytes: Buffer.from('%PDF'),
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
  applications = new ApplicationsService(
    db,
    new IdempotencyService(db),
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
  interactions = new HiringInteractionService(db);
  candidateView = new CandidateViewService(
    db,
    employers,
    interactions,
    filesStub,
  );
  wallet = new WalletService(db, employers, config);
  // §9.1's chat gate asks `between()` the same question BR-09 does, so the unlock reaches it
  // without a line of chat code changing - which is the property worth a test rather than an
  // assumption, because it is exactly the kind of inherited behaviour that regresses quietly.
  chat = new ChatService(
    db,
    interactions,
    filesStub,
    new IdempotencyService(db),
    notifications,
  );
});

afterAll(async () => {
  for (const id of users) {
    await db
      .deleteFrom('candidate_unlocks')
      .where((eb) =>
        eb.or([
          eb('employer_user_id', '=', id),
          eb('candidate_user_id', '=', id),
        ]),
      )
      .execute();
  }

  for (const id of users) {
    // An employer who has held a wallet cannot be deleted: `employer_wallets.user_id` is
    // RESTRICT because §6.7 keeps payment records and BR-24 forbids rewriting the ledger.
    // The guarantee under test, working - `RetentionService` anonymizes these instead.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    if (held) {
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
    .orderBy('sort_order')
    .executeTakeFirstOrThrow();

  return row.id;
}

/** A region that actually has a district under it - not every one does. */
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

/** A user with a phone nothing else has taken - these suites leave employers behind. */
async function newUser(role: 'candidate' | 'employer'): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = `+99891${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
    const row = await db
      .insertInto('users')
      .values({ phone, locale: 'uz-Latn' })
      .onConflict((oc) => oc.column('phone').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!row) {
      continue;
    }

    await db
      .insertInto('user_roles')
      .values({ user_id: row.id, role })
      .execute();
    users.push(row.id);

    return row.id;
  }

  throw new Error('could not find a free test phone number in 20 attempts');
}

async function storedFile(
  ownerUserId: string,
  purposeCode: string,
): Promise<string> {
  const unique = randomUUID();
  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: await seededId('file_purpose', purposeCode),
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

/** An employer, verified unless asked otherwise, with a wallet holding the bonus. */
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
    await verification.submit(employerUserId, [
      await storedFile(employerUserId, 'company_registration'),
    ]);
  }

  // The wallet, and BR-15's ten Coins - through the real path, so the fixture cannot put a
  // balance in place the product could not reach.
  await wallet.read(employerUserId);

  return employerUserId;
}

/** An active vacancy belonging to this employer, so a candidate has something to apply to. */
async function publishedVacancy(employerUserId: string): Promise<string> {
  const { regionId, districtId } = await region();
  const draft = await vacancies.create(employerUserId);
  const vacancyId = draft.aggregate.row.id;

  await vacancies.patch(employerUserId, vacancyId, {
    occupation_id: await seededId('occupation', 'call_centre_operator'),
    title: 'Call-centre operator',
    description:
      'Twenty operators for the Tashkent contact centre, Russian C1.',
    worker_count: 20,
    region_id: regionId,
    district_id: districtId,
    employment_type_ids: [await seededId('employment_type', 'full_time')],
    salary: {
      from: 5_000_000,
      to: 8_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
  });
  // Moderation is off in this suite, so submitting activates it.
  await vacancies.submit(employerUserId, vacancyId);

  return vacancyId;
}

/** A searchable, complete candidate with a CV attached. */
async function newCandidate(
  visibility: 'searchable' | 'hidden' = 'searchable',
): Promise<{ candidateUserId: string; cvFileId: string }> {
  const candidateUserId = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(candidateUserId, {
    full_name: 'Dilnoza Yusupova',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'call_centre_operator'),
  });
  await candidates.setVisibility(candidateUserId, visibility);

  return {
    candidateUserId,
    cvFileId: await storedFile(candidateUserId, 'cv'),
  };
}

describe('what counts as an entitlement (§11.1)', () => {
  it('finds an unlock, and only when nothing stronger exists', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    // Nothing yet.
    expect(
      await interactions.between(employerUserId, candidateUserId),
    ).toBeNull();

    await wallet.unlock(employerUserId, candidateUserId);

    // The pair is the id, because `candidate_unlocks` has no surrogate key (BR-16).
    expect(await interactions.between(employerUserId, candidateUserId)).toEqual(
      {
        kind: 'unlocks',
        id: candidateUserId,
      },
    );
  });

  it('reports the application when the same employer holds both', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    await wallet.unlock(employerUserId, candidateUserId);

    const vacancyId = await publishedVacancy(employerUserId);
    await applications.apply(candidateUserId, vacancyId, null);

    // Precedence: the candidate's own application is the stronger claim, so an employer who
    // also paid is never told they are relying on the purchase.
    expect(await interactions.between(employerUserId, candidateUserId)).toEqual(
      {
        kind: 'applications',
        id: expect.any(String),
      },
    );

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );
    expect(view.exposureReason).toBe('application');
  });

  it('reports the invitation ahead of the unlock once accepted (§8.2)', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    await wallet.unlock(employerUserId, candidateUserId);
    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId: await publishedVacancy(employerUserId),
      message: 'Your profile fits our Russian-language queue.',
    });

    // A sent invitation is not something the candidate agreed to, so until they accept, the
    // unlock is what is carrying this.
    expect(await interactions.between(employerUserId, candidateUserId)).toEqual(
      {
        kind: 'unlocks',
        id: candidateUserId,
      },
    );

    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    expect(
      (await interactions.between(employerUserId, candidateUserId))?.kind,
    ).toBe('invitations');
  });
});

describe('an unlocked candidate who never applied (UAT-17)', () => {
  it('reveals the phone number, the files and why', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId, cvFileId } = await newCandidate();

    const before = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    // The state the app renders a locked profile from, and the remedy is in the code.
    expect(before.phone).toBeNull();
    expect(before.canViewFiles).toBe(false);
    expect(before.files).toEqual([]);
    expect(before.exposureReason).toBe('unlock_required');

    const unlock = await wallet.unlock(employerUserId, candidateUserId);
    expect(unlock.charged).toBe(true);

    const after = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    expect(after.phone).toMatch(/^\+998/);
    expect(after.canViewFiles).toBe(true);
    expect(after.exposureReason).toBe('candidate_unlock');
    // The path is scoped to what granted it, which for an unlock is the candidate.
    expect(after.files).toEqual([
      expect.objectContaining({
        id: cvFileId,
        downloadPath: `/unlocks/${candidateUserId}/files/${cvFileId}/content`,
      }),
    ]);
  });

  it('keeps working after the candidate hides their profile', async () => {
    // Decision 3, and the case that would have failed with nothing but a log line: §5.3's
    // `hidden` removes a profile from *search*, and an unlock is a purchase rather than a
    // request the candidate can take back.
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    await wallet.unlock(employerUserId, candidateUserId);
    await candidates.setVisibility(candidateUserId, 'hidden');

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    expect(view.phone).toMatch(/^\+998/);
    expect(view.exposureReason).toBe('candidate_unlock');
  });

  it('is refused to an employer who has not paid, at the same URL', async () => {
    const paying = await newEmployer();
    const notPaying = await newEmployer();
    const { candidateUserId, cvFileId } = await newCandidate();

    await wallet.unlock(paying, candidateUserId);

    await expect(
      candidateView.downloadForUnlock(paying, candidateUserId, cvFileId),
    ).resolves.toMatchObject({ bytes: expect.any(Buffer) });

    // One 404 for "no unlock", "no such file" and "not theirs": which it was is not
    // information we owe (§11.1).
    await expect(
      candidateView.downloadForUnlock(notPaying, candidateUserId, cvFileId),
    ).rejects.toMatchObject({ messageKey: 'file.not_found' });
  });

  it('refuses a file that belongs to somebody else', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();
    const other = await newCandidate();

    await wallet.unlock(employerUserId, candidateUserId);

    await expect(
      candidateView.downloadForUnlock(
        employerUserId,
        candidateUserId,
        other.cvFileId,
      ),
    ).rejects.toMatchObject({ messageKey: 'file.not_found' });
  });
});

describe('what else inherits the entitlement', () => {
  it('opens §9.1 chat for an employer who unlocked but was never applied to', async () => {
    // **The reason the change went into `between()` rather than only into `expose()`.** §9.1's
    // gate and BR-09 ask the same question, and an employer who may read a phone number but
    // cannot send a message - or the reverse - would be a rule nobody wrote. Chat inherited
    // this without a line of its own changing, and this test is what keeps that true.
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    await expect(
      chat.open(employerUserId, 'employer', candidateUserId),
    ).rejects.toMatchObject({ messageKey: 'chat.no_interaction' });

    await wallet.unlock(employerUserId, candidateUserId);

    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    expect(conversation.candidateUserId).toBe(candidateUserId);
  });
});

describe('the purchase itself', () => {
  it('refuses an unverified employer before taking any Coins (§7)', async () => {
    // §7 lets only a verified employer see candidates at all, so charging one who cannot is
    // taking money for nothing. Refused with the code every other §7-gated route returns, so
    // the client routes to verification rather than to top-up.
    const employerUserId = await newEmployer(false);
    const { candidateUserId } = await newCandidate();

    await expect(
      wallet.unlock(employerUserId, candidateUserId),
    ).rejects.toMatchObject({ messageKey: 'employer.not_verified' });

    // Nothing moved: the balance is still the registration bonus, and no entitlement exists.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
    expect(await wallet.hasUnlock(employerUserId, candidateUserId)).toBe(false);
  });

  it('answers 404 for a candidate that does not exist, rather than a constraint error', async () => {
    const employerUserId = await newEmployer();

    await expect(
      wallet.unlock(employerUserId, '11111111-2222-4333-8444-555555555555'),
    ).rejects.toMatchObject({ messageKey: 'candidate.profile_not_found' });

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
  });

  it('reports the cost and the balance together, for one-request confirmation (§6.6)', async () => {
    const employerUserId = await newEmployer();
    const { candidateUserId } = await newCandidate();

    const state = await wallet.unlockFor(employerUserId, candidateUserId);
    expect(state).toBeNull();

    // The three numbers UAT-17 needs on the sheet: cost, balance, and what is left.
    const view = await wallet.read(employerUserId);
    expect(view.pricing.candidateUnlockCoins).toBe(2);
    expect(view.balanceCoins).toBe(10);

    await wallet.unlock(employerUserId, candidateUserId);

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
    expect(
      await wallet.unlockFor(employerUserId, candidateUserId),
    ).toMatchObject({ candidateUserId, costCoins: 2, charged: false });
  });
});
