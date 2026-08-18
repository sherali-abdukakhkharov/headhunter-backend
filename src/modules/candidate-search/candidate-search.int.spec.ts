import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { ApplicationsService } from '@modules/applications/applications.service';
import { CandidateViewService } from '@modules/applications/candidate-view.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { HistoryService } from '@modules/candidates/history.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';

import { CandidateSearchService } from './candidate-search.service';
import type { CandidateSearchFilters } from './search-filters';

/**
 * Candidate search against a real Postgres (§7).
 *
 * These cannot be unit tests, and not only because of the usual reason. The whole module
 * is one SQL statement assembled from fragments: `DummyDriver` would compile it, run
 * nothing, and pass while every predicate was wrong. `search-query.spec.ts` pins the
 * *shape* of that SQL; this file is the only place its *meaning* is checked - that a
 * match-all filter really demands every skill, that a language floor really compares
 * ranks, and that BR-02's gate really keeps a hidden profile out.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let candidates: CandidatesService;
let history: HistoryService;
let vacancies: VacanciesService;
let applications: ApplicationsService;
let search: CandidateSearchService;
let searchCapped: CandidateSearchService;
let candidateView: CandidateViewService;

/**
 * The real notifications service over a no-op sender.
 *
 * Real rather than stubbed, so every one of these suites also exercises the notification
 * write M9 added to the flow it covers; no-op sender, so nothing reaches FCM.
 */
let notifications: NotificationsService;

const users: string[] = [];

function configWith(countCap: number): ConfigService<AppEnv, true> {
  return {
    get: (key: string) =>
      key === 'PLATFORM_TIME_ZONE'
        ? 'Asia/Tashkent'
        : key === 'SEARCH_COUNT_CAP'
          ? countCap
          : key === 'MODERATION_ENABLED' ||
              key === 'EMPLOYER_VERIFICATION_ENABLED'
            ? false
            : key === 'FILE_MAX_SIZE_BYTES'
              ? 10_485_760
              : undefined,
  } as unknown as ConfigService<AppEnv, true>;
}

const config = configWith(200);

/** Files are stubbed: what these tests cover is who may read, not Telegram. */
const filesStub = {
  readAsAuthorized: (ownerUserId: string, fileId: string) =>
    Promise.resolve({
      file: {
        id: fileId,
        purposeId: 'p',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
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
  history = new HistoryService(db, candidates, config);
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
  search = new CandidateSearchService(db, employers, filesStub, config);
  searchCapped = new CandidateSearchService(
    db,
    employers,
    filesStub,
    configWith(1),
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
  const phone = `+99897${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
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

  if (!verified) {
    return employerUserId;
  }

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

  // EMPLOYER_VERIFICATION_ENABLED is off, so this verifies directly - with its honest
  // audit row (M4).
  await new VerificationService(db, employers, notifications, config).submit(
    employerUserId,
    [file.id],
  );

  return employerUserId;
}

/**
 * A findable candidate: the five fields BR-02 requires for the professional category,
 * plus `searchable`.
 *
 * A profile is `hidden` by default (§11.1), so every one of these has to opt in - which
 * is also what makes the "a hidden profile is not findable" test meaningful rather than
 * accidental.
 */
async function newCandidate(
  fields: Record<string, unknown> = {},
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
    ...fields,
  });
  await candidates.setVisibility(userId, visibility);

  return userId;
}

/** Only ever the candidates this test made: the dev database has others. */
function idsIn(items: { candidateUserId: string }[]): string[] {
  return items.map((item) => item.candidateUserId);
}

async function find(
  employerUserId: string,
  filters: CandidateSearchFilters,
): Promise<string[]> {
  const { items } = await search.search(employerUserId, {
    filters,
    sort: 'match',
    limit: 50,
    offset: 0,
  });

  return idsIn(items);
}

describe('who may search at all (§7, BR-03)', () => {
  it('refuses an employer whose profile is not verified', async () => {
    const employerUserId = await newEmployer(false);

    // M4 left this test to be written with the routes it guards. `assertVerified`
    // distinguishes the two refusals, and an unverified-but-complete profile is the one
    // that must still be refused.
    await expect(find(employerUserId, {})).rejects.toThrow(ForbiddenError);
  });

  it('refuses an employer with no profile at all', async () => {
    const employerUserId = await newUser('employer');

    await expect(find(employerUserId, {})).rejects.toThrow(ForbiddenError);
  });

  it('refuses the count and the saved list too, not just the search', async () => {
    const employerUserId = await newEmployer(false);

    await expect(search.count(employerUserId, {})).rejects.toThrow(
      ForbiddenError,
    );
    await expect(search.listSaved(employerUserId, 10, 0)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('BR-02’s gate', () => {
  it('finds a searchable, complete profile', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    const found = await find(employerUserId, {
      occupationIds: [await seededId('occupation', 'call_centre_operator')],
    });

    expect(found).toContain(candidateUserId);
  });

  it('does not find a hidden profile', async () => {
    const employerUserId = await newEmployer();
    const hidden = await newCandidate({}, 'hidden');

    const found = await find(employerUserId, {
      occupationIds: [await seededId('occupation', 'call_centre_operator')],
    });

    expect(found).not.toContain(hidden);
  });

  it('does not find an incomplete profile, however visible', async () => {
    const userId = await newUser('candidate');
    const employerUserId = await newEmployer();

    // Missing four of the five required fields, so `is_complete` is false.
    await candidates.patch(userId, { full_name: 'Incomplete Person' });
    await candidates.setVisibility(userId, 'searchable');

    expect(await find(employerUserId, {})).not.toContain(userId);
  });

  it('refuses to save a candidate the employer could not have found', async () => {
    const employerUserId = await newEmployer();
    const hidden = await newCandidate({}, 'hidden');

    await expect(search.save(employerUserId, hidden)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('§7.1 filters', () => {
  it('matches skills with "any" and demands all of them with "all"', async () => {
    const employerUserId = await newEmployer();
    const level = await anyActive('skill_level');
    const crm = await seededId('skill', 'crm_work');
    const excel = await seededId('skill', 'customer_service');

    const both = await newCandidate({
      skills: [
        { itemId: crm, levelId: level },
        { itemId: excel, levelId: level },
      ],
    });
    const one = await newCandidate({
      skills: [{ itemId: crm, levelId: level }],
    });

    const any = await find(employerUserId, {
      skillIds: [crm, excel],
      skillsMatchMode: 'any',
    });
    const all = await find(employerUserId, {
      skillIds: [crm, excel],
      skillsMatchMode: 'all',
    });

    expect(any).toContain(both);
    expect(any).toContain(one);
    expect(all).toContain(both);
    // The whole point of the two plans: match-all is a promise the result keeps.
    expect(all).not.toContain(one);
  });

  it('compares a language level as a floor, not as equality (§7.4)', async () => {
    const employerUserId = await newEmployer();
    const russian = await seededId('language', 'russian');
    const b1 = await seededId('language_level', 'b1');
    const c1 = await seededId('language_level', 'c1');
    const c2 = await seededId('language_level', 'c2');
    const c1Rank = await levelRank(c1);

    const atC2 = await newCandidate({
      languages: [{ itemId: russian, levelId: c2 }],
    });
    const atB1 = await newCandidate({
      languages: [{ itemId: russian, levelId: b1 }],
    });

    const found = await find(employerUserId, {
      languages: [{ itemId: russian, minLevelRank: c1Rank }],
    });

    // "Russian C1" means C1 *or better* - the controlled example of §7.4 would find
    // nobody if this were equality.
    expect(found).toContain(atC2);
    expect(found).not.toContain(atB1);
  });

  it('asks for a certificate only when the filter did', async () => {
    const employerUserId = await newEmployer();
    const english = await seededId('language', 'english');
    const b2 = await seededId('language_level', 'b2');

    const withCertificate = await newCandidate({
      languages: [{ itemId: english, levelId: b2, has_certificate: true }],
    });
    const without = await newCandidate({
      languages: [{ itemId: english, levelId: b2 }],
    });

    const certified = await find(employerUserId, {
      languages: [{ itemId: english, requireCertificate: true }],
    });

    expect(certified).toContain(withCertificate);
    expect(certified).not.toContain(without);
  });

  it('filters on a work attribute stored as a candidate_attributes row', async () => {
    const employerUserId = await newEmployer();
    const licence = await seededId('attribute', 'licence_b');

    const holder = await newCandidate({ licence_ids: [licence] });
    const other = await newCandidate();

    const found = await find(employerUserId, { attributeIds: [licence] });

    expect(found).toContain(holder);
    expect(found).not.toContain(other);
  });

  it('filters on total years of experience', async () => {
    const employerUserId = await newEmployer();
    const experienced = await newCandidate();
    const fresh = await newCandidate();

    await history.addExperience(experienced, {
      roleTitle: 'Operator',
      startedOn: '2016-01-01',
      endedOn: '2024-01-01',
      isCurrent: false,
      employerName: 'Uzum',
      occupationId: await seededId('occupation', 'call_centre_operator'),
      responsibilities: null,
    });

    const found = await find(employerUserId, { experienceYearsMin: 5 });

    expect(found).toContain(experienced);
    expect(found).not.toContain(fresh);
  });

  it('filters by specialization id, across scripts (§3.3, BR-13)', async () => {
    const employerUserId = await newEmployer();
    const softwareEngineering = await seededId(
      'specialization',
      'software_engineering',
    );
    const accounting = await seededId('specialization', 'accounting_audit');

    // A professional-category profile: `specialization` is one of §5.2's category
    // fields, so it only exists where the schema says it does.
    const professional = await seededId('occupation', 'software_developer');
    const engineer = await newCandidate({
      primary_occupation_id: professional,
      specialization: [softwareEngineering],
    });
    const accountant = await newCandidate({
      primary_occupation_id: professional,
      specialization: [accounting],
    });

    const found = await find(employerUserId, {
      specializationIds: [softwareEngineering],
    });

    // The point of the dictionary: the same id whichever of the four variants either
    // person is using. A text filter would have matched one spelling of one language.
    expect(found).toContain(engineer);
    expect(found).not.toContain(accountant);
  });

  it('refuses to filter occupation experience with no occupation selected', async () => {
    const employerUserId = await newEmployer();

    await expect(
      find(employerUserId, { occupationExperienceYearsMin: 3 }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('lets a negotiable expectation through a budget, and excludes a higher one', async () => {
    const employerUserId = await newEmployer();
    const period = await anyActive('payment_period');

    // Negotiable and a range are mutually exclusive (M3's CHECK), so this states no
    // figure at all - which is exactly the case a budget filter must not exclude.
    const negotiable = await newCandidate({
      salary: { from: null, to: null, periodId: period, isNegotiable: true },
    });
    const expensive = await newCandidate({
      salary: {
        from: 20_000_000,
        to: 30_000_000,
        periodId: period,
        isNegotiable: false,
      },
    });
    const affordable = await newCandidate({
      salary: {
        from: 3_000_000,
        to: 5_000_000,
        periodId: period,
        isNegotiable: false,
      },
    });

    const found = await find(employerUserId, { salaryMax: 6_000_000 });

    expect(found).toContain(affordable);
    expect(found).toContain(negotiable);
    expect(found).not.toContain(expensive);
  });

  it('filters availability by date, and "immediately" against today', async () => {
    const employerUserId = await newEmployer();
    const soon = await newCandidate({ available_from: '2026-01-01' });
    const later = await newCandidate({ available_from: '2099-01-01' });

    const byDate = await find(employerUserId, { availableBy: '2026-09-01' });
    const now = await find(employerUserId, { availableImmediately: true });

    expect(byDate).toContain(soon);
    expect(byDate).not.toContain(later);
    expect(now).toContain(soon);
    expect(now).not.toContain(later);
  });
});

describe('BR-12 conditional filters (§7.1)', () => {
  it('refuses an age filter with no justification', async () => {
    const employerUserId = await newEmployer();

    await expect(find(employerUserId, { ageMin: 30 })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('refuses a justification that does not cover the restriction asked for', async () => {
    const employerUserId = await newEmployer();

    // A gender-only reason cannot justify an age filter, and the rule that says so is
    // the same one a vacancy's restriction is checked against.
    await expect(
      find(employerUserId, {
        ageMin: 30,
        restrictionJustificationId: await seededId(
          'restriction_justification',
          'single_sex_facility',
        ),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('allows an age filter justified by a permitted reason', async () => {
    const employerUserId = await newEmployer();
    const adult = await newCandidate({ date_of_birth: '1990-01-01' });
    const young = await newCandidate({ date_of_birth: '2010-01-01' });

    const found = await find(employerUserId, {
      ageMin: 21,
      restrictionJustificationId: await seededId(
        'restriction_justification',
        'statutory_minimum_age',
      ),
    });

    expect(found).toContain(adult);
    expect(found).not.toContain(young);
  });
});

describe('§7.2’s count', () => {
  it('counts exactly below the cap', async () => {
    const employerUserId = await newEmployer();
    const skill = await seededId('skill', 'sql');
    const level = await anyActive('skill_level');
    await newCandidate({ skills: [{ itemId: skill, levelId: level }] });
    await newCandidate({ skills: [{ itemId: skill, levelId: level }] });

    const result = await search.count(employerUserId, { skillIds: [skill] });

    expect(result.isExact).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it('answers "n+" once the cap is passed rather than counting on', async () => {
    const employerUserId = await newEmployer();
    await newCandidate();
    await newCandidate();

    // A cap of one, so two matches are enough to prove the bounded count - the
    // alternative is a test that inserts two hundred profiles to exercise one branch.
    const result = await searchCapped.count(employerUserId, {});

    expect(result).toEqual({ count: 1, isExact: false });
  });
});

describe('§7.3’s ranking and card', () => {
  it('scores a fuller match higher, and explains itself', async () => {
    const employerUserId = await newEmployer();
    const level = await anyActive('skill_level');
    const crm = await seededId('skill', 'crm_work');
    const excel = await seededId('skill', 'customer_service');
    const both = await newCandidate({
      skills: [
        { itemId: crm, levelId: level },
        { itemId: excel, levelId: level },
      ],
    });
    const one = await newCandidate({
      skills: [{ itemId: crm, levelId: level }],
    });

    const { items } = await search.search(employerUserId, {
      filters: { skillIds: [crm, excel], skillsMatchMode: 'any' },
      sort: 'match',
      limit: 50,
      offset: 0,
    });
    const byId = new Map(items.map((item) => [item.candidateUserId, item]));

    expect(byId.get(both)?.matchScore).toBe(100);
    expect(byId.get(one)?.matchScore).toBe(50);
    // "Why did this candidate rank here" is answerable from the response itself.
    expect(byId.get(one)?.matchBreakdown).toEqual([
      { group: 'skills', weight: 3, asked: 2, matched: 1 },
    ]);
  });

  it('returns the page in the order it scored, so paging cannot disagree with ranking', async () => {
    const employerUserId = await newEmployer();
    const level = await anyActive('skill_level');
    const crm = await seededId('skill', 'crm_work');
    const excel = await seededId('skill', 'customer_service');
    await newCandidate({
      skills: [
        { itemId: crm, levelId: level },
        { itemId: excel, levelId: level },
      ],
    });
    await newCandidate({ skills: [{ itemId: crm, levelId: level }] });

    const { items } = await search.search(employerUserId, {
      filters: { skillIds: [crm, excel], skillsMatchMode: 'any' },
      sort: 'match',
      limit: 50,
      offset: 0,
    });
    const scores = items.map((item) => item.matchScore);

    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('sorts by tiered proximity: same district, then same region, then the rest', async () => {
    const employerUserId = await newEmployer();
    const { regionId, districtId } = await region();
    const otherDistrict = await db
      .selectFrom('dictionary_items')
      .select('id')
      .where('parent_id', '=', regionId)
      .where('id', '!=', districtId)
      .where('is_active', '=', true)
      .executeTakeFirstOrThrow();
    const otherRegion = await db
      .selectFrom('dictionary_items')
      .select('id')
      .where('type_code', '=', 'region')
      .where('parent_id', 'is', null)
      .where('id', '!=', regionId)
      .executeTakeFirstOrThrow();
    const farDistrict = await db
      .selectFrom('dictionary_items')
      .select('id')
      .where('parent_id', '=', otherRegion.id)
      .where('is_active', '=', true)
      .executeTakeFirstOrThrow();

    const near = await newCandidate({
      region_id: regionId,
      district_id: districtId,
    });
    const sameRegion = await newCandidate({
      region_id: regionId,
      district_id: otherDistrict.id,
    });
    const far = await newCandidate({
      region_id: otherRegion.id,
      district_id: farDistrict.id,
    });

    const { items } = await search.search(employerUserId, {
      // No location *filter*: the point of the sort is to order candidates a wide search
      // returned, and filtering by district would leave it nothing to order. That is why
      // the reference point is its own field.
      filters: { proximityDistrictId: districtId },
      sort: 'proximity',
      limit: 50,
      offset: 0,
    });
    const order = idsIn(items);

    // Tiers, not distances: places are dictionary ids here, and this is what the region
    // tree can honestly support. Same district, then same region, then the rest.
    expect(order.indexOf(near)).toBeLessThan(order.indexOf(sameRegion));
    expect(order.indexOf(sameRegion)).toBeLessThan(order.indexOf(far));
  });

  it('leaves the order to the tiebreaker when there is nothing to be near', async () => {
    const employerUserId = await newEmployer();
    await newCandidate();

    // Documented rather than refused: the result set is identical either way, and only
    // the order within it is undefined.
    await expect(
      search.search(employerUserId, {
        filters: {},
        sort: 'proximity',
        limit: 5,
        offset: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('scores an unfiltered search 100 for everyone rather than dividing by zero', async () => {
    const employerUserId = await newEmployer();
    await newCandidate();

    const { items, groups } = await search.search(employerUserId, {
      filters: {},
      sort: 'match',
      limit: 5,
      offset: 0,
    });

    expect(groups).toEqual([]);
    for (const item of items) {
      expect(item.matchScore).toBe(100);
      expect(item.matchBreakdown).toEqual([]);
    }
  });

  it('never puts a phone number on a card (§11.1)', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const { phone } = await db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', candidateUserId)
      .executeTakeFirstOrThrow();

    const { items } = await search.search(employerUserId, {
      filters: {},
      sort: 'recent',
      limit: 50,
      offset: 0,
    });

    // The strong form: not "phone is null" but "the number is nowhere in the response".
    expect(JSON.stringify(items)).not.toContain(phone as string);
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('phone');
    }
  });

  it('carries the candidate’s skills, languages and current role', async () => {
    const employerUserId = await newEmployer();
    const skill = await seededId('skill', 'crm_work');
    const level = await anyActive('skill_level');
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');
    const candidateUserId = await newCandidate({
      skills: [{ itemId: skill, levelId: level }],
      languages: [{ itemId: russian, levelId: c1 }],
    });
    await history.addExperience(candidateUserId, {
      roleTitle: 'Senior operator',
      startedOn: '2020-01-01',
      endedOn: null,
      isCurrent: true,
      employerName: 'Uzum',
      occupationId: await seededId('occupation', 'call_centre_operator'),
      responsibilities: null,
    });

    const { items } = await search.search(employerUserId, {
      filters: { skillIds: [skill] },
      sort: 'match',
      limit: 50,
      offset: 0,
    });
    const card = items.find((item) => item.candidateUserId === candidateUserId);

    expect(card?.skills).toEqual([
      expect.objectContaining({ itemId: skill, levelId: level }),
    ]);
    expect(card?.languages).toEqual([
      expect.objectContaining({ itemId: russian, hasCertificate: false }),
    ]);
    expect(card?.currentRoleTitle).toBe('Senior operator');
    expect(card?.experienceYears).toBeGreaterThan(0);
  });

  it('offers a photo path only when a photo exists, and serves it', async () => {
    const employerUserId = await newEmployer();
    const withPhoto = await newCandidate();
    const without = await newCandidate();
    const unique = randomUUID();
    await db
      .insertInto('stored_files')
      .values({
        owner_user_id: withPhoto,
        purpose_id: await seededId('file_purpose', 'photo'),
        telegram_file_id: `fake-${unique}`,
        telegram_file_unique_id: unique,
        telegram_message_id: '2',
        file_name: 'me.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 64,
        sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
      })
      .execute();

    const { items } = await search.search(employerUserId, {
      filters: {},
      sort: 'recent',
      limit: 50,
      offset: 0,
    });
    const byId = new Map(items.map((item) => [item.candidateUserId, item]));

    expect(byId.get(withPhoto)?.photoPath).toContain(withPhoto);
    expect(byId.get(without)?.photoPath).toBeNull();

    // The narrow exception to BR-09's file gate: a photo, and nothing else.
    await expect(
      search.photo(employerUserId, withPhoto),
    ).resolves.toMatchObject({ file: { mimeType: 'image/jpeg' } });
    await expect(search.photo(employerUserId, without)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('§7.3’s saves, notes and shortlists', () => {
  it('saves idempotently and lists the card back', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    await search.save(employerUserId, candidateUserId);
    await search.save(employerUserId, candidateUserId);

    const saved = await search.listSaved(employerUserId, 50, 0);

    expect(idsIn(saved)).toEqual([candidateUserId]);
    expect(saved[0].isSaved).toBe(true);
  });

  it('keeps the private note on the save, and shows it on the card', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    await search.setNote(
      employerUserId,
      candidateUserId,
      'Strong on the phone.',
    );
    const saved = await search.listSaved(employerUserId, 50, 0);

    // Writing a note saves the candidate: the note is about the save.
    expect(saved[0].note).toBe('Strong on the phone.');

    await search.setNote(employerUserId, candidateUserId, null);
    expect((await search.listSaved(employerUserId, 50, 0))[0].note).toBeNull();
  });

  it('shows one employer’s note to nobody else', async () => {
    const first = await newEmployer();
    const second = await newEmployer();
    const candidateUserId = await newCandidate();

    await search.setNote(first, candidateUserId, 'Ours only.');

    const { items } = await search.search(second, {
      filters: {},
      sort: 'recent',
      limit: 50,
      offset: 0,
    });
    const card = items.find((item) => item.candidateUserId === candidateUserId);

    expect(card?.note).toBeNull();
    expect(card?.isSaved).toBe(false);
  });

  it('drops a candidate who hides their profile from the saved list', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    await search.save(employerUserId, candidateUserId);

    await candidates.setVisibility(candidateUserId, 'hidden');

    // "Hide me from search" must not be defeated by whoever saved you first. The row
    // survives, so the candidate reappears if they choose to.
    expect(idsIn(await search.listSaved(employerUserId, 50, 0))).toEqual([]);

    const rows = await db
      .selectFrom('saved_candidates')
      .select('candidate_user_id')
      .where('employer_user_id', '=', employerUserId)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('unsaves', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    await search.save(employerUserId, candidateUserId);
    await search.unsave(employerUserId, candidateUserId);

    expect(await search.listSaved(employerUserId, 50, 0)).toEqual([]);
  });

  it('shortlists per vacancy, and flags it on the card when the search names one', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;

    await search.shortlist(employerUserId, vacancyId, candidateUserId);

    const listed = await search.listShortlist(employerUserId, vacancyId, 50, 0);
    expect(idsIn(listed)).toEqual([candidateUserId]);
    expect(listed[0].isShortlisted).toBe(true);

    const { items } = await search.search(employerUserId, {
      filters: {},
      sort: 'recent',
      limit: 50,
      offset: 0,
      vacancyId,
    });
    expect(
      items.find((item) => item.candidateUserId === candidateUserId)
        ?.isShortlisted,
    ).toBe(true);

    await search.unshortlist(employerUserId, vacancyId, candidateUserId);
    expect(
      await search.listShortlist(employerUserId, vacancyId, 50, 0),
    ).toEqual([]);
  });

  it('never lets an employer touch another employer’s shortlist', async () => {
    const owner = await newEmployer();
    const stranger = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = (await vacancies.create(owner)).aggregate.row.id;

    // 404, not 403: the existence of the vacancy is not information we owe (§11.1).
    await expect(
      search.shortlist(stranger, vacancyId, candidateUserId),
    ).rejects.toThrow(NotFoundError);
    await expect(
      search.listShortlist(stranger, vacancyId, 50, 0),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('UAT-06: search opened from a vacancy', () => {
  it('prefills the vacancy’s mandatory requirements as filters', async () => {
    const employerUserId = await newEmployer();
    const { regionId, districtId } = await region();
    const occupation = await seededId('occupation', 'call_centre_operator');
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');
    const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;

    await vacancies.patch(employerUserId, vacancyId, {
      occupation_id: occupation,
      title: 'Call-centre operator',
      description: 'Twenty operators for the Russian-language queue.',
      worker_count: 20,
      region_id: regionId,
      district_id: districtId,
      languages: [{ itemId: russian, levelId: c1, is_mandatory: true }],
      employment_type_ids: [await seededId('employment_type', 'full_time')],
    });

    const filters = await search.prefill(employerUserId, vacancyId);

    // §7.4's controlled example, as a filter set: twenty Russian C1 operators.
    expect(filters).toMatchObject({
      occupationIds: [occupation],
      regionId,
      districtIds: [districtId],
      languages: [{ itemId: russian, minLevelRank: await levelRank(c1) }],
    });
  });

  it('finds the candidate the prefilled filters describe', async () => {
    const employerUserId = await newEmployer();
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');
    const occupation = await seededId('occupation', 'call_centre_operator');
    const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;
    await vacancies.patch(employerUserId, vacancyId, {
      occupation_id: occupation,
      languages: [{ itemId: russian, levelId: c1, is_mandatory: true }],
    });

    const operator = await newCandidate({
      languages: [{ itemId: russian, levelId: c1 }],
    });
    const noRussian = await newCandidate();

    const found = await find(
      employerUserId,
      await search.prefill(employerUserId, vacancyId),
    );

    expect(found).toContain(operator);
    expect(found).not.toContain(noRussian);
  });

  it('refuses to prefill from another employer’s vacancy', async () => {
    const owner = await newEmployer();
    const stranger = await newEmployer();
    const vacancyId = (await vacancies.create(owner)).aggregate.row.id;

    await expect(search.prefill(stranger, vacancyId)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('§7.3’s "View profile" and BR-09', () => {
  it('shows a searchable stranger without contact details', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    expect(view.phone).toBeNull();
    expect(view.canViewFiles).toBe(false);
    expect(view.exposureReason).toBe('unlock_required');
  });

  it('reveals contact details once the candidate has applied', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    await applications.apply(candidateUserId, vacancyId, null);

    const view = await candidateView.forCandidate(
      employerUserId,
      candidateUserId,
    );

    expect(view.phone).not.toBeNull();
    expect(view.exposureReason).toBe('application');
  });

  it('keeps an applicant readable after they hide their profile', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    await applications.apply(candidateUserId, vacancyId, null);
    await candidates.setVisibility(candidateUserId, 'hidden');

    // §5.3's "hide from global search" was never a promise to stop the employer they
    // wrote to from reading them.
    await expect(
      candidateView.forCandidate(employerUserId, candidateUserId),
    ).resolves.toMatchObject({ exposureReason: 'application' });
  });

  it('hides a profile that is neither findable nor interacting', async () => {
    const employerUserId = await newEmployer();
    const hidden = await newCandidate({}, 'hidden');

    await expect(
      candidateView.forCandidate(employerUserId, hidden),
    ).rejects.toThrow(NotFoundError);
  });
});

async function levelRank(itemId: string): Promise<number> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('rank')
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();

  return row.rank as number;
}

/** A published vacancy of this employer's, so a candidate can apply into it. */
async function publishedVacancy(employerUserId: string): Promise<string> {
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

  return vacancyId;
}
