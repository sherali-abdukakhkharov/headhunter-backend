import { createHash, randomUUID } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AccountStatusGuard } from '@infra/api/guards/account-status.guard';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import { AuthService } from '@modules/auth/auth.service';
import { OtpService } from '@modules/auth/otp.service';
import { SessionService } from '@modules/auth/session.service';
import { LoggingSmsSender } from '@modules/auth/sms/logging-sms.sender';
import { TokenService } from '@modules/auth/token.service';
import { AuditService } from '@modules/admin/audit.service';
import { AdminModerationService } from '@modules/admin/moderation.service';
import { AdminUsersService } from '@modules/admin/users-admin.service';
import { ApplicationsService } from '@modules/applications/applications.service';
import { CandidateViewService } from '@modules/applications/candidate-view.service';
import { CandidateSearchService } from '@modules/candidate-search/candidate-search.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { ChatService } from '@modules/chat/chat.service';
import { HistoryService } from '@modules/candidates/history.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { DiscoveryService } from '@modules/discovery/discovery.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { InterviewsService } from '@modules/interviews/interviews.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';
import { PaymentOrdersService } from '@modules/payments/payment-orders.service';
import { ClickProvider } from '@modules/payments/providers/click.provider';
import { PaymentProviderRegistry } from '@modules/payments/providers/payment-provider.registry';
import { PaymeProvider } from '@modules/payments/providers/payme.provider';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { UsersService } from '@modules/users/users.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { WalletService } from '@modules/wallet/wallet.service';

/**
 * The client's acceptance scenarios, walked end to end (§13.2, UAT-01..UAT-23).
 *
 * **§13.1 has twenty-four scenarios since the 2026-08-10 revision**, and twenty-three of them
 * are here - UAT-24 is a restatement of UAT-13 and is covered by it.
 *
 * The original fifteen still assert that a hiring interaction reveals contact details, and that
 * is still true: M12's retrofit was built on the reading that an application is one of §11.1's
 * "explicitly approved entitlements", so nothing here had to be rewritten. What changed is the
 * *reason code* for a refusal - `no_interaction` became `unlock_required`, because the remedy is
 * now a purchase rather than waiting.
 *
 * Every other suite in this repository tests a module. This one tests the *product*: each
 * `describe` is one row of §13's table, and its title is that row's scenario. The test
 * inside asserts the row's stated expected result and nothing else - where a scenario is
 * silent, this file stays silent too, so a passing run means what the client wrote is
 * true, not what an engineer decided it should have said.
 *
 * It runs against a real Postgres through the production services, in the order a real
 * user would: register, fill a profile, publish, search, invite, apply, interview. Only
 * two things are simulated, and both are marked where they happen - the SMS that would
 * carry an OTP, and the passage of time in UAT-15.
 *
 * When a scenario needs something this product deliberately does not do, that is written
 * in the test rather than worked around.
 */

let db: Database;
let destroy: () => Promise<void>;

let otp: OtpService;
let auth: AuthService;
let usersService: UsersService;
let dictionaries: DictionariesService;
let candidates: CandidatesService;
let history: HistoryService;
let employers: EmployersService;
let verification: VerificationService;
let vacancies: VacanciesService;
let search: CandidateSearchService;
let invitations: InvitationsService;
let applications: ApplicationsService;
let interviews: InterviewsService;
let chat: ChatService;
let candidateView: CandidateViewService;
let discovery: DiscoveryService;
let notifications: NotificationsService;
let moderation: AdminModerationService;
let adminUsers: AdminUsersService;
let guard: AccountStatusGuard;
let wallet: WalletService;
let payments: PaymentOrdersService;
let payme: PaymeProvider;
let click: ClickProvider;

const users: string[] = [];

/** M13's test credentials. Real signatures, so the callbacks below genuinely verify. */
const PAYME_KEY = 'uat-payme-merchant-key';
const CLICK_SECRET = 'uat-click-secret';
const CLICK_SERVICE = 'uat-click-service';

/**
 * Both moderation flags **on**, because §13's scenarios describe a moderated product:
 * UAT-04 expects an administrator decision to be visible and UAT-05 expects a vacancy to
 * go active *after* moderation. Running these with the MVP flags off would pass while
 * testing something the client did not describe.
 */
const ENV: Record<string, string | number | boolean> = {
  PLATFORM_TIME_ZONE: 'Asia/Tashkent',
  MODERATION_ENABLED: true,
  EMPLOYER_VERIFICATION_ENABLED: true,
  FILE_MAX_SIZE_BYTES: 10_485_760,
  SEARCH_COUNT_CAP: 200,
  TOKEN_HASH_PEPPER: 'uat-integration-pepper-at-least-32-characters',
  JWT_SECRET: 'uat-integration-jwt-secret-at-least-32-chars',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_RESEND_DELAY_SECONDS: 0,
  OTP_MAX_ATTEMPTS: 5,
  OTP_ECHO_IN_RESPONSE: true,

  // The Coin economy at §6.6's stated initial values, which UAT-16, UAT-17, UAT-19 and
  // UAT-20 all quote as numbers: 10 free Coins, 2 per unlock, UZS 10 000 each.
  COIN_PRICE_UZS: 10_000,
  CANDIDATE_UNLOCK_COINS: 2,
  EMPLOYER_REGISTRATION_BONUS_COINS: 10,

  // M13. Both providers configured, so UAT-20..23 exercise verified callbacks.
  PAYMENT_MIN_COINS: 1,
  PAYMENT_MAX_COINS: 1_000,
  PAYME_MERCHANT_ID: 'uat-merchant',
  PAYME_MERCHANT_KEY: PAYME_KEY,
  PAYME_CHECKOUT_URL: 'https://checkout.paycom.uz',
  PAYME_ACCOUNT_FIELD: 'order_id',
  CLICK_MERCHANT_ID: 'uat-click-merchant',
  CLICK_SERVICE_ID: CLICK_SERVICE,
  CLICK_SECRET_KEY: CLICK_SECRET,
  CLICK_MERCHANT_USER_ID: '',
  CLICK_CHECKOUT_URL: 'https://my.click.uz/services/pay',
};

const config = {
  get: (key: string) => ENV[key],
} as unknown as ConfigService<AppEnv, true>;

/**
 * Telegram stands in for itself.
 *
 * These scenarios are about *who may read a file*, which is this API's rule, not about
 * whether Telegram returns bytes, which is `files.int.spec.ts`'s job.
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
  const idempotency = new IdempotencyService(db);
  const audit = new AuditService(db);

  // No SMS provider on this instance, which is the state UAT-01 actually runs in: the
  // logging sender reports failure and `OtpService` leaves the code in place, so
  // `OTP_ECHO_IN_RESPONSE` returns it exactly as a developer would see.
  otp = new OtpService(db, new LoggingSmsSender(), config);
  auth = new AuthService(
    db,
    new SessionService(db, config),
    new TokenService(new JwtService({}), config),
  );
  usersService = new UsersService(db);

  dictionaries = new DictionariesService(db);
  const schemas = new SchemasService(db, dictionaries, config);
  const validator = new FieldValidatorService(dictionaries, config);

  candidates = new CandidatesService(db, schemas, validator);
  history = new HistoryService(db, candidates, config);
  employers = new EmployersService(db);
  verification = new VerificationService(db, employers, notifications, config);
  vacancies = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    notifications,
    config,
  );
  search = new CandidateSearchService(db, employers, filesStub, config);
  invitations = new InvitationsService(
    db,
    employers,
    dictionaries,
    idempotency,
    notifications,
    config,
  );
  applications = new ApplicationsService(
    db,
    idempotency,
    notifications,
    config,
  );
  interviews = new InterviewsService(db, applications, notifications);
  candidateView = new CandidateViewService(
    db,
    employers,
    new HiringInteractionService(db),
    filesStub,
  );
  discovery = new DiscoveryService(db, config);
  moderation = new AdminModerationService(
    db,
    verification,
    vacancies,
    filesStub,
    audit,
  );
  adminUsers = new AdminUsersService(db, audit, notifications);
  guard = new AccountStatusGuard(db);
  // §9.1's chat gate reads the same shared entitlement BR-09 does, which is what lets UAT-17
  // assert its "chat becomes available" clause without chat knowing an unlock exists.
  chat = new ChatService(
    db,
    new HiringInteractionService(db),
    filesStub,
    idempotency,
    notifications,
  );

  // M12 and M13. Both payment providers are configured here with test credentials, because
  // UAT-20..23 are about *verified* callbacks: a scenario that ran against an unconfigured
  // provider would assert a refusal and prove nothing about crediting.
  wallet = new WalletService(db, employers, config);
  payme = new PaymeProvider(config);
  click = new ClickProvider(config);
  payments = new PaymentOrdersService(
    db,
    new PaymentProviderRegistry(payme, click),
    wallet,
    config,
  );
});

afterAll(async () => {
  for (const id of users) {
    // An administrator who has acted is left behind on purpose: the audit log's actor
    // reference is RESTRICT and its rows are append-only (§10.4), so not even its own
    // test can erase who decided what. BR-14's purge has to answer for these rows.
    const acted = await db
      .selectFrom('admin_audit_log')
      .select('id')
      .where('actor_user_id', '=', id)
      .executeTakeFirst();

    // An employer who has held a wallet is left behind for the same reason, one constraint
    // later: `employer_wallets.user_id` is RESTRICT because §6.7 requires payment records to
    // survive for reconciliation and BR-24 forbids rewriting the ledger. `payment_events` is
    // append-only too, so not even this test can erase why a Coin was credited.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    // And the administrator who made UAT-19's adjustment is held by the ledger's *other*
    // RESTRICT, `wallet_transactions.actor_user_id` - which is what makes §10.5's "who
    // adjusted this balance" unerasable.
    const adjusted = await db
      .selectFrom('wallet_transactions')
      .select('id')
      .where('actor_user_id', '=', id)
      .executeTakeFirst();

    if (acted || held || adjusted) {
      continue;
    }

    await db
      .deleteFrom('candidate_unlocks')
      .where((eb) =>
        eb.or([
          eb('employer_user_id', '=', id),
          eb('candidate_user_id', '=', id),
        ]),
      )
      .execute();
    await db.deleteFrom('employers').where('user_id', '=', id).execute();
    await db
      .deleteFrom('stored_files')
      .where('owner_user_id', '=', id)
      .execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

// --- fixtures ---------------------------------------------------------------

function testPhone(): string {
  return `+99897${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
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

async function anyActive(type: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return row.id;
}

/**
 * A language level's comparable rank.
 *
 * `rank`, never `sort_order`: the second is the order a picker renders in, and using it
 * as a floor would compare C1 against a display position (BR-13).
 */
async function levelRank(code: string): Promise<number> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('rank')
    .where('type_code', '=', 'language_level')
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.rank as number;
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

/** Straight into the table, for the roles §13 does not ask us to register. */
/**
 * A user with a phone number nothing else has taken.
 *
 * The retry matters because this suite deliberately cannot delete every user it creates -
 * administrators who acted and employers who hold a wallet stay behind - so the digits
 * available under `+99897` accumulate across runs and a random one eventually collides with
 * a row an earlier run left. Asking the unique index is cheaper than hoping.
 */
async function newUser(role: 'candidate' | 'employer' | 'admin'): Promise<{
  userId: string;
  phone: string;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = testPhone();
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

    return { userId: row.id, phone };
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
      size_bytes: 4,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/** UAT-02's profile: occupation, experience, Russian C1, location, work preferences. */
async function completeCandidate(): Promise<string> {
  const { userId } = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(userId, {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'call_centre_operator'),
    languages: [
      {
        itemId: await seededId('language', 'russian'),
        levelId: await seededId('language_level', 'c1'),
      },
    ],
    employment_type_ids: [await seededId('employment_type', 'full_time')],
  });

  await history.addExperience(userId, {
    occupationId: await seededId('occupation', 'call_centre_operator'),
    employerName: 'Beeline Uzbekistan',
    roleTitle: 'Call-centre operator',
    startedOn: '2021-03-01',
    endedOn: '2025-12-31',
    isCurrent: false,
    responsibilities: 'Inbound support for Russian-speaking subscribers.',
  });

  await candidates.setVisibility(userId, 'searchable');

  return userId;
}

/** A verified employer, through §6.1's submission and an administrator's decision. */
async function verifiedEmployer(): Promise<{
  employerUserId: string;
  adminUserId: string;
}> {
  const { userId: employerUserId } = await newUser('employer');
  const { userId: adminUserId } = await newUser('admin');
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
  await verification.submit(employerUserId, [
    await storedFile(employerUserId, 'company_registration'),
  ]);
  await moderation.decideVerification(
    adminUserId,
    employerUserId,
    'verified',
    null,
  );

  return { employerUserId, adminUserId };
}

/** UAT-05's vacancy: twenty call-centre positions requiring Russian C1. */
async function callCentreVacancy(
  employerUserId: string,
  adminUserId: string,
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
    languages: [
      {
        itemId: await seededId('language', 'russian'),
        levelId: await seededId('language_level', 'c1'),
        is_mandatory: true,
      },
    ],
    salary: {
      from: 4_000_000,
      to: 6_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
  });

  await vacancies.submit(employerUserId, vacancyId);
  await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

  return vacancyId;
}

/** A candidate feed page. Discovery pages every query, so there is no unpaged call. */
const FEED = { limit: 100, offset: 0 };

function contextFor(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: userId }, method: 'POST' }),
    }),
  } as unknown as ExecutionContext;
}

// --- the scenarios ----------------------------------------------------------

describe('UAT-01 - a new candidate selects an interface variant, registers by phone and OTP, and enters candidate onboarding', () => {
  it('creates the account and retains the selected locale', async () => {
    const phone = testPhone();

    // The SMS is the only simulated step: no provider is connected, so the code comes
    // back in the send result exactly as OTP_ECHO_IN_RESPONSE returns it in development.
    // Everything after this line is the production path (§4.1, docs/SMS_PROVIDER.md).
    const sent = await otp.send(phone, 'login', null);
    await otp.verify(phone, 'login', sent.devCode as string);

    const tokens = await auth.completePhoneVerification(phone, 'ru', {
      fingerprint: 'uat-01',
      platform: 'android',
    });

    expect(tokens.isNewUser).toBe(true);
    expect(tokens.accessToken).toBeTruthy();
    // No role yet: a new account routes into onboarding rather than a home screen, which
    // is what `isNewUser` tells the client.
    expect(tokens.roles).toEqual([]);

    const created = await db
      .selectFrom('users')
      .select(['id', 'locale'])
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();

    users.push(created.id);
    expect(created.locale).toBe('ru');

    // Onboarding: the choice of role is the candidate's, and it survives the request.
    expect(await auth.selectRoles(created.id, ['candidate'])).toEqual([
      'candidate',
    ]);
    expect((await usersService.findProfile(created.id)).locale).toBe('ru');
  });
});

describe('UAT-02 - candidate enters occupation, experience, Russian C1, location and work preferences', () => {
  it('saves the profile and makes it searchable once required fields and visibility are complete', async () => {
    const candidateUserId = await completeCandidate();
    const profile = await candidates.read(candidateUserId);

    expect(profile.completeness.isComplete).toBe(true);
    expect(profile.aggregate.row.visibility).toBe('searchable');
    expect(await history.listExperience(candidateUserId)).toHaveLength(1);

    // "Searchable" is a claim about the employer's search, so it is asserted there.
    const { employerUserId } = await verifiedEmployer();
    const { items } = await search.search(employerUserId, {
      filters: {
        occupationIds: [await seededId('occupation', 'call_centre_operator')],
        languages: [
          {
            itemId: await seededId('language', 'russian'),
            minLevelRank: await levelRank('c1'),
          },
        ],
      },
      sort: 'match',
      limit: 50,
      offset: 0,
    });

    expect(items.map((card) => card.candidateUserId)).toContain(
      candidateUserId,
    );
  });

  it('keeps an incomplete profile out of search, whatever its visibility', async () => {
    const { userId } = await newUser('candidate');
    await candidates.patch(userId, { full_name: 'Dilnoza Yusupova' });
    await candidates.setVisibility(userId, 'searchable');

    // BR-02 is `is_complete`, not the percentage: a profile with no occupation is not
    // searchable however visible its owner has made it.
    expect((await candidates.read(userId)).completeness.isComplete).toBe(false);

    const { employerUserId } = await verifiedEmployer();
    const { items } = await search.search(employerUserId, {
      filters: {},
      sort: 'recent',
      limit: 200,
      offset: 0,
    });

    expect(items.map((card) => card.candidateUserId)).not.toContain(userId);
  });
});

describe('UAT-03 - candidate uploads a PDF CV', () => {
  it('lets an authorized employer read the file, and nobody else', async () => {
    const candidateUserId = await completeCandidate();
    const cvId = await storedFile(candidateUserId, 'cv');
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);

    // Authorization is the application, not possession of the id: before one exists the
    // same employer asking for the same file is refused (BR-09).
    await expect(
      candidateView.forCandidate(employerUserId, candidateUserId),
    ).resolves.toMatchObject({ files: [] });

    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      'I have five years of Russian-language support experience.',
    );

    const view = await candidateView.forApplication(
      employerUserId,
      application.id,
    );
    expect(view.files.map((file) => file.id)).toContain(cvId);

    const download = await candidateView.downloadForApplication(
      employerUserId,
      application.id,
      cvId,
    );
    expect(download.bytes.toString()).toBe('%PDF');

    // A different employer, with no interaction, cannot reach the same file.
    const stranger = await verifiedEmployer();
    await expect(
      candidateView.downloadForApplication(
        stranger.employerUserId,
        application.id,
        cvId,
      ),
    ).rejects.toThrow();
  });
});

describe('UAT-04 - employer creates and submits a company profile', () => {
  it('shows the verification status and the administrator decision', async () => {
    const { userId: employerUserId } = await newUser('employer');
    const { userId: adminUserId } = await newUser('admin');
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

    expect((await employers.findMine(employerUserId)).verificationStatus).toBe(
      'not_submitted',
    );

    await verification.submit(employerUserId, [
      await storedFile(employerUserId, 'company_registration'),
    ]);

    expect((await employers.findMine(employerUserId)).verificationStatus).toBe(
      'under_review',
    );

    // The queue is the administrator's side of the same fact.
    const queue = await moderation.verificationQueue(50, 0);
    expect(queue.map((item) => item.employerUserId)).toContain(employerUserId);

    await moderation.decideVerification(
      adminUserId,
      employerUserId,
      'changes_required',
      'The registration certificate is unreadable; please re-upload it.',
    );

    const decided = await employers.findMine(employerUserId);
    expect(decided.verificationStatus).toBe('changes_required');
    // "Administrator decision are visible": the reason is the decision, and a status
    // without one would tell the employer nothing about what to fix.
    expect(decided.verificationReason).toContain('unreadable');

    // BR-08: the decision wrote its history row in the same transaction as the status.
    const trail = await db
      .selectFrom('employer_verification_history')
      .select(['to_status', 'actor_role'])
      .where('employer_user_id', '=', employerUserId)
      .orderBy('created_at')
      .execute();

    expect(trail).toEqual([
      expect.objectContaining({ to_status: 'under_review' }),
      expect.objectContaining({
        to_status: 'changes_required',
        actor_role: 'admin',
      }),
    ]);
  });
});

describe('UAT-05 - verified employer creates a 20-position call-centre vacancy with Russian C1', () => {
  it('stores the vacancy and activates it after moderation', async () => {
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const { regionId, districtId } = await region();
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');

    const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;
    await vacancies.patch(employerUserId, vacancyId, {
      occupation_id: await seededId('occupation', 'call_centre_operator'),
      title: 'Call-centre operator',
      description: 'Answer customer calls in Russian and Uzbek, politely.',
      worker_count: 20,
      region_id: regionId,
      district_id: districtId,
      employment_type_ids: [await seededId('employment_type', 'full_time')],
      languages: [{ itemId: russian, levelId: c1, is_mandatory: true }],
      salary: {
        from: 4_000_000,
        to: 6_000_000,
        periodId: await seededId('payment_period', 'monthly'),
        isNegotiable: false,
      },
    });

    const submitted = await vacancies.submit(employerUserId, vacancyId);
    // Not active on submission: BR-04 puts a human between the employer and the feed.
    expect(submitted.aggregate.row.status).toBe('under_moderation');

    const queued = await moderation.moderationQueue(50, 0);
    expect(queued.map((item) => item.vacancyId)).toContain(vacancyId);

    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    const active = await vacancies.read(employerUserId, vacancyId);
    expect(active.aggregate.row.status).toBe('active');
    expect(active.aggregate.row.worker_count).toBe(20);
    expect(active.aggregate.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldCode: 'languages',
          itemId: russian,
          levelId: c1,
          isMandatory: true,
        }),
      ]),
    );
  });
});

describe('UAT-06 - employer opens candidate search from the vacancy', () => {
  it('prefills the filters from the vacancy’s own requirements', async () => {
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);
    const { regionId, districtId } = await region();

    const filters = await search.prefill(employerUserId, vacancyId);

    expect(filters.occupationIds).toEqual([
      await seededId('occupation', 'call_centre_operator'),
    ]);
    expect(filters.regionId).toBe(regionId);
    expect(filters.districtIds).toEqual([districtId]);
    expect(filters.employmentTypeIds).toEqual([
      await seededId('employment_type', 'full_time'),
    ]);
    // Language *and* level, because "Russian" without "C1" is a different vacancy. The
    // level arrives as a rank floor: the requirement is C1 or better, not exactly C1.
    expect(filters.languages).toEqual([
      {
        itemId: await seededId('language', 'russian'),
        minLevelRank: await levelRank('c1'),
      },
    ]);

    // Prefilled, not applied: the scenario says the filters are filled in, and an
    // employer who edits them must get their own search back.
    const narrowed = await search.search(employerUserId, {
      filters: { ...filters, languages: [] },
      sort: 'match',
      limit: 20,
      offset: 0,
    });
    expect(Array.isArray(narrowed.items)).toBe(true);
  });
});

describe('UAT-07 - employer saves candidates and sends invitations', () => {
  it('notifies the candidate, who can then respond', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);

    await search.save(employerUserId, candidateUserId);
    const saved = await search.listSaved(employerUserId, 50, 0);
    expect(saved.map((card) => card.candidateUserId)).toContain(
      candidateUserId,
    );

    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'Your Russian is what our support queue needs. Interested?',
    });

    const inbox = await notifications.list(candidateUserId, 'ru', {}, 20, 0);
    expect(inbox.map((item) => item.event)).toContain('invitation_received');
    // Rendered in the reader's language, from a stored key rather than stored prose.
    expect(inbox[0]?.text).toMatch(/[А-Яа-я]/);

    const accepted = await invitations.respond(
      candidateUserId,
      invitation.id,
      'accepted',
      'Yes - I am available from Monday.',
    );
    expect(accepted.status).toBe('accepted');

    const employerInbox = await notifications.list(
      employerUserId,
      'en',
      {},
      20,
      0,
    );
    expect(employerInbox.map((item) => item.event)).toContain(
      'invitation_responded',
    );
  });
});

describe('UAT-08 - candidate applies to an active vacancy', () => {
  it('creates one active application, visible to both parties', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);

    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      'I have five years of Russian-language support experience.',
    );
    expect(application.status).toBe('submitted');

    // "One active application" is BR-07, and it is a partial unique index rather than a
    // check in the service - so a second attempt is refused by the database.
    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toThrow();

    const mine = await applications.listForCandidate(candidateUserId);
    expect(mine.map((row) => row.id)).toContain(application.id);

    const theirs = await applications.listForVacancy(employerUserId, vacancyId);
    expect(theirs.map((row) => row.id)).toContain(application.id);
  });
});

describe('UAT-09 - employer moves the application to Interview and creates an appointment', () => {
  it('shows the candidate the new status and the interview details', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);
    const application = await applications.apply(
      candidateUserId,
      vacancyId,
      null,
    );

    await applications.moveStage(
      employerUserId,
      application.id,
      'viewed',
      null,
    );
    const atInterview = await applications.moveStage(
      employerUserId,
      application.id,
      'interview',
      'Strong Russian; worth meeting.',
    );
    expect(atInterview.status).toBe('interview');

    const scheduledAt = new Date('2026-09-01T09:00:00.000Z');
    const interview = await interviews.schedule(
      employerUserId,
      application.id,
      {
        type: 'in_person',
        scheduledAt,
        location: 'Tashkent, Amir Temur 108, 4th floor',
        instructions: 'Ask for Anvar at reception; bring your passport.',
      },
    );

    // The candidate's own view: the status they see and the appointment they were given.
    const mine = await applications.listForCandidate(candidateUserId);
    expect(mine.find((row) => row.id === application.id)?.status).toBe(
      'interview',
    );

    const appointments = await interviews.listForCandidate(candidateUserId);
    expect(appointments).toEqual([
      expect.objectContaining({
        id: interview.id,
        type: 'in_person',
        location: 'Tashkent, Amir Temur 108, 4th floor',
        status: 'scheduled',
      }),
    ]);
    expect(appointments[0]?.scheduledAt.toISOString()).toBe(
      scheduledAt.toISOString(),
    );

    const inbox = await notifications.list(
      candidateUserId,
      'uz-Latn',
      {},
      20,
      0,
    );
    expect(inbox.map((item) => item.event)).toContain('interview_scheduled');
  });
});

describe('UAT-10 - employer creates a seasonal cotton-planting vacancy', () => {
  it('saves the work type, location, dates, worker count and payment method', async () => {
    const { employerUserId } = await verifiedEmployer();
    const { regionId, districtId } = await region();
    const daily = await seededId('payment_period', 'daily');

    const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;
    await vacancies.patch(employerUserId, vacancyId, {
      occupation_id: await seededId('occupation', 'planting_worker'),
      title: 'Cotton planting - seasonal crew',
      description:
        'Planting cotton on 40 hectares near Gulbahor; transport provided.',
      worker_count: 150,
      region_id: regionId,
      district_id: districtId,
      starts_on: '2027-04-05',
      ends_on: '2027-05-20',
      employment_type_ids: [await seededId('employment_type', 'seasonal')],
      salary: {
        from: 120_000,
        to: 150_000,
        periodId: daily,
        isNegotiable: false,
      },
    });

    const stored = (await vacancies.read(employerUserId, vacancyId)).aggregate;

    // The category is derived from the occupation, never sent by the client - which is
    // what stops a vacancy claiming a field set its work does not have.
    expect(stored.row.category).toBe('seasonal_agricultural');
    expect(stored.row.worker_count).toBe(150);
    expect(stored.row.starts_on).toBe('2027-04-05');
    expect(stored.row.ends_on).toBe('2027-05-20');
    // A calendar date is a string end to end; a `Date` here would be the day before for
    // five hours out of every Tashkent day.
    expect(typeof stored.row.starts_on).toBe('string');
    // "Payment method": daily rate, which is how seasonal work is actually paid here.
    expect(stored.row.salary_period_id).toBe(daily);
    // Numeric, so the scale is part of the value: money is never a float here.
    expect(stored.row.salary_from).toBe('120000.00');
  });
});

describe('UAT-11 - administrator approves an employer and moderates a vacancy from the mobile admin menu', () => {
  it('changes both statuses and notifies the employer', async () => {
    const { userId: adminUserId } = await newUser('admin');
    const { userId: employerUserId } = await newUser('employer');
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
    await verification.submit(employerUserId, [
      await storedFile(employerUserId, 'company_registration'),
    ]);
    await moderation.decideVerification(
      adminUserId,
      employerUserId,
      'verified',
      null,
    );

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
    });
    await vacancies.submit(employerUserId, vacancyId);
    await moderation.moderateVacancy(adminUserId, vacancyId, 'active', null);

    expect((await employers.findMine(employerUserId)).verificationStatus).toBe(
      'verified',
    );
    expect(
      (await vacancies.read(employerUserId, vacancyId)).aggregate.row.status,
    ).toBe('active');

    const inbox = await notifications.list(employerUserId, 'ru', {}, 20, 0);
    expect(inbox.map((item) => item.event)).toEqual(
      expect.arrayContaining(['verification_decided', 'vacancy_moderated']),
    );

    // §10.4: an administrator's decision is auditable, and both decisions are here.
    const trail = await db
      .selectFrom('admin_audit_log')
      .select(['action', 'target_type'])
      .where('actor_user_id', '=', adminUserId)
      .execute();

    expect(trail.map((row) => row.target_type).sort()).toEqual([
      'employer',
      'vacancy',
    ]);
  });
});

describe('UAT-12 - candidate hides the profile from global search', () => {
  it('removes the profile from new employer searches', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId } = await verifiedEmployer();
    const filters = {
      occupationIds: [await seededId('occupation', 'call_centre_operator')],
    };

    const before = await search.search(employerUserId, {
      filters,
      sort: 'recent',
      limit: 200,
      offset: 0,
    });
    expect(before.items.map((card) => card.candidateUserId)).toContain(
      candidateUserId,
    );

    const beforeAt = (await candidates.read(candidateUserId)).aggregate.row
      .last_meaningful_update_at;

    await candidates.setVisibility(candidateUserId, 'hidden');

    const after = await search.search(employerUserId, {
      filters,
      sort: 'recent',
      limit: 200,
      offset: 0,
    });
    expect(after.items.map((card) => card.candidateUserId)).not.toContain(
      candidateUserId,
    );

    // §5.3: a privacy toggle is not a content edit, so it must not push the profile up
    // a recency sort. This is structural - visibility has its own route.
    expect(
      (await candidates.read(candidateUserId)).aggregate.row
        .last_meaningful_update_at,
    ).toEqual(beforeAt);
  });
});

describe('UAT-13 - user changes interface from Uzbek Latin to Uzbek Cyrillic, Russian and English', () => {
  it('changes every system label while leaving user-entered content alone', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);

    await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
      message: 'Sizning rus tilingiz bizga mos keladi.',
    });

    const locales = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;
    const dictionaryLabels: string[] = [];
    const notificationTexts: string[] = [];

    for (const locale of locales) {
      await usersService.updateLocale(candidateUserId, locale);
      expect((await usersService.findProfile(candidateUserId)).locale).toBe(
        locale,
      );

      // Dictionary labels: BR-13's four variants of one stable id.
      const delta = await dictionaries.delta('employment_type', locale, null);
      dictionaryLabels.push(delta.items[0]?.label ?? '');

      // System text: a notification stores a key, so the language it renders in is the
      // reader's *now*, not the reader's when it was written.
      const inbox = await notifications.list(candidateUserId, locale, {}, 5, 0);
      notificationTexts.push(inbox[0]?.text ?? '');
    }

    expect(new Set(dictionaryLabels).size).toBe(4);
    expect(new Set(notificationTexts).size).toBe(4);

    // User-entered content is not translated and must not change: the candidate's own
    // name and the employer's own message are theirs.
    expect((await candidates.read(candidateUserId)).fields.full_name).toBe(
      'Anvar Karimov',
    );
    const received = await invitations.listReceived(candidateUserId);
    expect(received[0]?.message).toBe('Sizning rus tilingiz bizga mos keladi.');
  });
});

describe('UAT-14 - administrator temporarily blocks a user', () => {
  it('fails restricted operations with a clear reason, and audits the action', async () => {
    const { userId: adminUserId } = await newUser('admin');
    const candidateUserId = await completeCandidate();

    await adminUsers.changeStatus(
      adminUserId,
      candidateUserId,
      'restricted',
      'Suspected duplicate accounts; under review for seven days.',
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );

    // "Restricted operations fail": BR-10 is a guard on every mutating route, not a
    // check inside each service, so this is asserted where it is enforced.
    await expect(
      guard.canActivate(contextFor(candidateUserId)),
    ).rejects.toMatchObject({ messageKey: 'account.restricted_action' });

    // "With a clear reason": the reason the administrator typed reaches the user, and
    // the client renders it under the localized message.
    const detail = await adminUsers.detail(adminUserId, candidateUserId);
    expect(detail.status).toBe('restricted');
    expect(detail.statusHistory[0]?.reason).toContain('duplicate accounts');
    expect(detail.restrictedUntil).toBeInstanceOf(Date);

    // "And the action is audited": both the account-status history the user's own
    // timeline reads (BR-08) and the administrator's append-only log (§10.4).
    expect(
      await db
        .selectFrom('account_status_history')
        .select(['to_status', 'reason'])
        .where('user_id', '=', candidateUserId)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        to_status: 'restricted',
        reason: 'Suspected duplicate accounts; under review for seven days.',
      }),
    ]);

    const audited = await db
      .selectFrom('admin_audit_log')
      .select(['action', 'target_id'])
      .where('actor_user_id', '=', adminUserId)
      .execute();
    expect(audited).toEqual([
      expect.objectContaining({
        action: 'user.restricted',
        target_id: candidateUserId,
      }),
    ]);

    // A restriction is temporary by definition: lifting it restores the account, and
    // leaves its own row - the log records what was undone as well as what was done.
    await adminUsers.changeStatus(
      adminUserId,
      candidateUserId,
      'active',
      'Review closed; no duplicates found.',
    );
    await expect(guard.canActivate(contextFor(candidateUserId))).resolves.toBe(
      true,
    );

    const afterLift = await db
      .selectFrom('admin_audit_log')
      .select('action')
      .where('actor_user_id', '=', adminUserId)
      .orderBy('created_at')
      .execute();
    expect(afterLift.map((row) => row.action)).toEqual([
      'user.restricted',
      'user.unblocked',
    ]);
  });
});

describe('UAT-15 - a vacancy deadline expires', () => {
  it('blocks new applications and drops the vacancy from active discovery', async () => {
    const candidateUserId = await completeCandidate();
    const { employerUserId, adminUserId } = await verifiedEmployer();
    const vacancyId = await callCentreVacancy(employerUserId, adminUserId);

    const visible = await discovery.recent(candidateUserId, FEED);
    expect(visible.map((item) => item.id)).toContain(vacancyId);

    // Time passes. There is no scheduler to advance and no reason to add one: expiry is
    // a predicate on `deadline_on`, evaluated by every read, so moving the deadline into
    // the past is exactly equivalent to waiting (ARCHITECTURE.md - "expiry is a query,
    // not a job"). A `patch` could not do this: the write path refuses a past deadline,
    // which is the correct rule and the reason this one line is raw SQL.
    await db
      .updateTable('vacancies')
      .set({ deadline_on: '2026-01-01' })
      .where('id', '=', vacancyId)
      .execute();

    await expect(
      applications.apply(candidateUserId, vacancyId, null),
    ).rejects.toMatchObject({ messageKey: 'application.vacancy_closed' });

    const afterwards = await discovery.recent(candidateUserId, FEED);
    expect(afterwards.map((item) => item.id)).not.toContain(vacancyId);

    const recommended = await discovery.recommended(candidateUserId, FEED);
    expect(recommended.map((item) => item.id)).not.toContain(vacancyId);

    // Gone from discovery, not gone: the employer still owns it and can see why it
    // stopped attracting applications.
    const owned = await vacancies.read(employerUserId, vacancyId);
    expect(owned.aggregate.row.deadline_on).toBe('2026-01-01');
  });
});

// --- M12 and M13: the Coin wallet, Candidate Unlock, and top-up -------------

/** A Payme JSON-RPC callback, authenticated exactly as Payme authenticates its own. */
function paymeCall(
  method: string,
  params: Record<string, unknown>,
): { headers: Record<string, string>; body: unknown } {
  const credential = Buffer.from(`Paycom:${PAYME_KEY}`, 'utf8').toString(
    'base64',
  );

  return {
    headers: { authorization: `Basic ${credential}` },
    body: { method, params, id: 1 },
  };
}

/** A CLICK callback, signed with the merchant secret over CLICK's own field order. */
function clickCall(
  action: '0' | '1',
  fields: {
    orderId: string;
    amountUzs: number;
    clickTransId: string;
    prepareId?: string;
    error?: string;
  },
): { headers: Record<string, string>; body: unknown } {
  const amount = fields.amountUzs.toFixed(2);
  const signTime = '2026-08-18 12:00:00';
  const signature = createHash('md5')
    .update(
      [
        fields.clickTransId,
        CLICK_SERVICE,
        CLICK_SECRET,
        fields.orderId,
        ...(action === '1' ? [fields.prepareId ?? ''] : []),
        amount,
        action,
        signTime,
      ].join(''),
      'utf8',
    )
    .digest('hex');

  return {
    headers: {},
    body: {
      click_trans_id: fields.clickTransId,
      service_id: CLICK_SERVICE,
      merchant_trans_id: fields.orderId,
      ...(action === '1' ? { merchant_prepare_id: fields.prepareId } : {}),
      amount,
      action,
      error: fields.error ?? '0',
      sign_time: signTime,
      sign_string: signature,
    },
  };
}

describe('UAT-16 - a user completes first employer registration', () => {
  it('creates the wallet and credits exactly ten free Coins, once', async () => {
    const { userId: employerUserId } = await newUser('employer');

    const view = await wallet.read(employerUserId);

    expect(view.balanceCoins).toBe(10);
    expect(view.registrationBonusAt).toBeInstanceOf(Date);

    // "Exactly once" is the whole scenario, and §6.6 lists four ways it would be retried -
    // logout, reinstall, device change, role switching. Each is this call happening again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .transaction()
        .execute((trx) => wallet.grantRegistrationBonus(trx, employerUserId));
    }

    expect((await wallet.read(employerUserId)).balanceCoins).toBe(10);
  });
});

describe('UAT-17 - employer with 10 Coins unlocks a new candidate', () => {
  it('debits two Coins and opens the contact details, the CV and chat', async () => {
    const { employerUserId } = await verifiedEmployer();
    const candidateUserId = await completeCandidate();

    // Before: the locked state the app renders, and the code that says what would fix it.
    const locked = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );
    expect(locked.phone).toBeNull();
    expect(locked.canViewFiles).toBe(false);
    expect(locked.exposureReason).toBe('unlock_required');

    await wallet.read(employerUserId);
    const unlock = await wallet.unlock(employerUserId, candidateUserId);

    expect(unlock.charged).toBe(true);
    expect(unlock.costCoins).toBe(2);
    // The number the scenario states.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);

    // "Protected phone/e-mail, CV, chat, and interview/contact actions become available."
    const unlocked = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );
    expect(unlocked.phone).toMatch(/^\+998/);
    expect(unlocked.canViewFiles).toBe(true);
    expect(unlocked.exposureReason).toBe('candidate_unlock');

    // Chat, without a line of chat code knowing an unlock exists: §9.1's gate asks the same
    // shared question BR-09 does, which is why the retrofit went there rather than only into
    // the exposure rule.
    await expect(
      chat.open(employerUserId, 'employer', candidateUserId),
    ).resolves.toMatchObject({ candidateUserId });
  });
});

describe('UAT-18 - employer revisits the same already-unlocked candidate', () => {
  it('charges nothing more and keeps the entitlement', async () => {
    const { employerUserId } = await verifiedEmployer();
    const candidateUserId = await completeCandidate();

    await wallet.read(employerUserId);
    await wallet.unlock(employerUserId, candidateUserId);

    const again = await wallet.unlock(employerUserId, candidateUserId);

    expect(again.charged).toBe(false);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(8);
    expect(await wallet.hasUnlock(employerUserId, candidateUserId)).toBe(true);
  });
});

describe('UAT-19 - employer with fewer than 2 Coins attempts Candidate Unlock', () => {
  it('blocks the unlock and says what a top-up would cost', async () => {
    const { employerUserId } = await verifiedEmployer();
    const candidateUserId = await completeCandidate();
    const { userId: adminUserId } = await newUser('admin');

    await wallet.read(employerUserId);
    // Down to one Coin through a real ledger entry, so even the fixture cannot put the
    // wallet in a state the product could not reach.
    await wallet.adjust(adminUserId, employerUserId, -9, 'UAT-19 fixture.');

    await expect(
      wallet.unlock(employerUserId, candidateUserId),
    ).rejects.toMatchObject({ messageKey: 'wallet.insufficient_coins' });

    // "The Wallet top-up action is shown": the server's half of that is telling the client
    // what a top-up would be for, and which providers can take it.
    const view = await wallet.read(employerUserId);
    expect(view.balanceCoins).toBe(1);
    expect(view.pricing.candidateUnlockCoins).toBe(2);
    expect(payments.availableProviders()).toEqual(['payme', 'click']);

    // And the refusal wrote no entitlement.
    expect(await wallet.hasUnlock(employerUserId, candidateUserId)).toBe(false);
  });
});

describe('UAT-20 - employer buys 10 Coins through Payme at the initial price', () => {
  it('creates a UZS 100 000 order and credits exactly ten Coins once', async () => {
    const { employerUserId } = await verifiedEmployer();
    const { order } = await payments.create(
      employerUserId,
      'payme',
      10,
      'uz-Latn',
    );

    // The scenario's own arithmetic.
    expect(order.amountUzs).toBe(100_000);
    expect(order.status).toBe('created');

    const before = (await wallet.read(employerUserId)).balanceCoins;
    const transactionId = `uat20-${order.id}`;

    // The provider's lifecycle, in the order Payme performs it (§12.6).
    const allowed = (await payments.handleCallback(
      'payme',
      paymeCall('CheckPerformTransaction', {
        // Payme speaks tiyin.
        amount: order.amountUzs * 100,
        account: { order_id: order.id },
      }),
    )) as { body: { result: { allow: boolean } } };

    expect(allowed.body.result.allow).toBe(true);

    await payments.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: order.amountUzs * 100,
        account: { order_id: order.id },
      }),
    );

    const performed = (await payments.handleCallback(
      'payme',
      paymeCall('PerformTransaction', { id: transactionId }),
    )) as { body: { result: { state: number } } };

    expect(performed.body.result.state).toBe(2);

    const paid = await payments.read(employerUserId, order.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(before + 10);
  });
});

describe('UAT-21 - employer buys Coins through CLICK', () => {
  it('moves the order to PAID on verified completion and credits once', async () => {
    const { employerUserId } = await verifiedEmployer();
    const { order } = await payments.create(
      employerUserId,
      'click',
      5,
      'uz-Latn',
    );
    const before = (await wallet.read(employerUserId)).balanceCoins;

    const prepared = (await payments.handleCallback(
      'click',
      clickCall('0', {
        orderId: order.id,
        amountUzs: order.amountUzs,
        clickTransId: `uat21-${order.id}`,
      }),
    )) as { body: { error: number; merchant_prepare_id: string } };

    expect(prepared.body.error).toBe(0);

    const completed = (await payments.handleCallback(
      'click',
      clickCall('1', {
        orderId: order.id,
        amountUzs: order.amountUzs,
        clickTransId: `uat21-${order.id}`,
        prepareId: prepared.body.merchant_prepare_id,
      }),
    )) as { body: { error: number } };

    expect(completed.body.error).toBe(0);
    expect((await payments.read(employerUserId, order.id)).status).toBe('paid');
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(before + 5);
  });
});

describe('UAT-22 - the same successful provider callback is delivered twice', () => {
  it('is idempotent and does not duplicate the wallet credit', async () => {
    const { employerUserId } = await verifiedEmployer();
    const { order } = await payments.create(
      employerUserId,
      'payme',
      10,
      'uz-Latn',
    );
    const transactionId = `uat22-${order.id}`;
    const perform = paymeCall('PerformTransaction', { id: transactionId });

    await payments.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: order.amountUzs * 100,
        account: { order_id: order.id },
      }),
    );

    await payments.handleCallback('payme', perform);
    const afterFirst = (await wallet.read(employerUserId)).balanceCoins;

    // The second delivery. Still a success, because telling Payme otherwise makes it retry
    // forever - and still one credit (BR-19).
    const second = (await payments.handleCallback('payme', perform)) as {
      body: { result: { state: number } };
    };

    expect(second.body.result.state).toBe(2);
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(afterFirst);

    const credits = await db
      .selectFrom('wallet_transactions')
      .select('id')
      .where('kind', '=', 'top_up')
      .where('reference_id', '=', order.id)
      .execute();

    expect(credits).toHaveLength(1);
  });
});

describe('UAT-23 - a Payme/CLICK payment fails or is cancelled', () => {
  it('credits no Coins and leaves the status and a retry visible in Wallet', async () => {
    const { employerUserId } = await verifiedEmployer();
    const before = (await wallet.read(employerUserId)).balanceCoins;

    // The Payme half: a transaction cancelled before it ever performed.
    const { order: paymeOrder } = await payments.create(
      employerUserId,
      'payme',
      10,
      'uz-Latn',
    );
    const transactionId = `uat23-${paymeOrder.id}`;

    await payments.handleCallback(
      'payme',
      paymeCall('CreateTransaction', {
        id: transactionId,
        amount: paymeOrder.amountUzs * 100,
        account: { order_id: paymeOrder.id },
      }),
    );
    await payments.handleCallback(
      'payme',
      paymeCall('CancelTransaction', { id: transactionId, reason: 3 }),
    );

    // The CLICK half: a completion carrying CLICK's own error.
    const { order: clickOrder } = await payments.create(
      employerUserId,
      'click',
      10,
      'uz-Latn',
    );
    const prepared = (await payments.handleCallback(
      'click',
      clickCall('0', {
        orderId: clickOrder.id,
        amountUzs: clickOrder.amountUzs,
        clickTransId: `uat23-${clickOrder.id}`,
      }),
    )) as { body: { merchant_prepare_id: string } };

    await payments.handleCallback(
      'click',
      clickCall('1', {
        orderId: clickOrder.id,
        amountUzs: clickOrder.amountUzs,
        clickTransId: `uat23-${clickOrder.id}`,
        prepareId: prepared.body.merchant_prepare_id,
        error: '-31',
      }),
    );

    // BR-20: neither one increased the balance.
    expect((await wallet.read(employerUserId)).balanceCoins).toBe(before);

    // "The final/retry status is visible in Wallet" - both orders, with a reason, in the
    // list the Wallet screen reads.
    const orderHistory = await payments.list(employerUserId, 20, 0);
    const byId = new Map(orderHistory.map((row) => [row.id, row]));

    expect(byId.get(paymeOrder.id)?.status).toBe('cancelled');
    expect(byId.get(clickOrder.id)?.status).toBe('cancelled');
    expect(byId.get(clickOrder.id)?.failureCode).toBe('-31');

    // Retrying is opening a new order, which the wallet permits with the old ones visible.
    const retry = await payments.create(employerUserId, 'payme', 10, 'uz-Latn');
    expect(retry.order.status).toBe('created');
  });
});
