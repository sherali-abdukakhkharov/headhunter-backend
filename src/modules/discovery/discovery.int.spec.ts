import type { ConfigService } from '@nestjs/config';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';

import { type DiscoveryFilters, DiscoveryService } from './discovery.service';

/**
 * §5.5's filters, against a real Postgres.
 *
 * These are SQL predicates and nothing else, so `DummyDriver` would compile every one
 * of them, run nothing, and pass. Three of the nine landed later than the rest and
 * carry the polarity decisions worth pinning:
 *
 * - **`salaryTo` is not the mirror of `salaryFrom`.** A vacancy is out only when its
 *   *floor* is above the ceiling asked for, so a NULL floor passes rather than failing
 *   the comparison.
 * - **`experienceYearsMax` is a `NOT EXISTS`.** Experience on a vacancy is a demand,
 *   not an attribute, so the filter hides what the candidate cannot reach - and a
 *   vacancy stating no requirement demands nothing, so it passes.
 * - **`languageIds` ignores the level**, matching the same semi-join the other three
 *   requirement filters use.
 *
 * Every assertion is scoped to the fixtures this file inserts. The development
 * database is shared with a running server and with twenty other specs, so an
 * assertion on the whole feed would be a test of whatever else happens to be published.
 */

let db: Database;
let destroy: () => Promise<void>;
let discovery: DiscoveryService;

/** Fixture vacancy ids by the name used in the tests. */
const vacancies = new Map<string, string>();
const users: string[] = [];

/** Every fixture vacancy id, for scoping an assertion to this file's rows. */
let mine: Set<string>;

const config = {
  get: (key: string) =>
    key === 'PLATFORM_TIME_ZONE' ? 'Asia/Tashkent' : undefined,
} as unknown as ConfigService<AppEnv, true>;

const RUSSIAN = 'russian';
const ENGLISH = 'english';
const KOREAN = 'korean';

async function languageId(code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'language')
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function levelC1(): Promise<{ id: string; rank: number }> {
  const row = await db
    .selectFrom('dictionary_items')
    // `rank` is the comparable ordinal - `sort_order` is display order, and the
    // two are not the same numbers.
    .select(['id', 'rank'])
    .where('type_code', '=', 'language_level')
    .where('code', '=', 'c1')
    .executeTakeFirstOrThrow();

  return { id: row.id, rank: row.rank as number };
}

async function user(role: 'candidate' | 'employer'): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ phone: fixturePhone(), locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();

  users.push(row.id);

  return row.id;
}

/**
 * Inserts one active vacancy directly.
 *
 * Not through `VacanciesService`: the write path has its own suite, and going through
 * it here would need a verified employer, a complete draft and a moderation decision
 * per row - a great deal of machinery between the fixture and the one `WHERE` clause
 * under test.
 */
async function vacancy(
  name: string,
  employerUserId: string,
  values: {
    salaryFrom?: number;
    salaryTo?: number;
    negotiable?: boolean;
  } = {},
): Promise<string> {
  const row = await db
    .insertInto('vacancies')
    .values({
      employer_user_id: employerUserId,
      title: `filter fixture: ${name}`,
      status: 'active',
      published_at: new Date(),
      salary_is_negotiable: values.negotiable ?? false,
      salary_from: values.salaryFrom?.toString() ?? null,
      salary_to: values.salaryTo?.toString() ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  vacancies.set(name, row.id);

  return row.id;
}

async function requireYears(name: string, years: number): Promise<void> {
  await db
    .insertInto('vacancy_requirements')
    .values({
      vacancy_id: vacancies.get(name) as string,
      field_code: 'experience_years_min',
      value_int: years,
    })
    .execute();
}

async function requireLanguage(
  name: string,
  itemId: string,
  level?: { id: string; rank: number },
): Promise<void> {
  await db
    .insertInto('vacancy_requirements')
    .values({
      vacancy_id: vacancies.get(name) as string,
      field_code: 'languages',
      item_id: itemId,
      level_id: level?.id ?? null,
      level_rank: level?.rank ?? null,
    })
    .execute();
}

/** The fixture names this file's filters returned, in no particular order. */
async function matching(
  candidateUserId: string,
  filters: Partial<DiscoveryFilters>,
): Promise<string[]> {
  const items = await discovery.recent(candidateUserId, {
    limit: 50,
    offset: 0,
    ...filters,
  });

  const byId = new Map([...vacancies].map(([name, id]) => [id, name]));

  return items
    .filter((item) => mine.has(item.id))
    .map((item) => byId.get(item.id) as string)
    .sort();
}

let candidate: string;

beforeAll(async () => {
  ({ db, destroy } = createIntTestDb());
  discovery = new DiscoveryService(db, config);

  candidate = await user('candidate');
  const employer = await user('employer');

  // The feed joins `employers`, so a vacancy without this row is invisible whatever
  // the filters say - which would make every one of these tests pass vacuously.
  await db
    .insertInto('employers')
    .values({ user_id: employer, type: 'company' })
    .execute();

  // --- pay ---------------------------------------------------------------
  await vacancy('pay_1m_to_2m', employer, {
    salaryFrom: 1_000_000,
    salaryTo: 2_000_000,
  });
  await vacancy('pay_8m_to_10m', employer, {
    salaryFrom: 8_000_000,
    salaryTo: 10_000_000,
  });
  // No floor stated. This is the row a symmetric mirror of `salaryFrom` gets wrong.
  await vacancy('pay_up_to_3m', employer, { salaryTo: 3_000_000 });
  await vacancy('pay_negotiable', employer, { negotiable: true });

  // --- experience --------------------------------------------------------
  await vacancy('exp_none', employer);
  await vacancy('exp_2', employer);
  await requireYears('exp_2', 2);
  await vacancy('exp_3', employer);
  await requireYears('exp_3', 3);
  await vacancy('exp_10', employer);
  await requireYears('exp_10', 10);

  // --- languages ---------------------------------------------------------
  await vacancy('lang_none', employer);
  await vacancy('lang_russian', employer);
  await requireLanguage('lang_russian', await languageId(RUSSIAN));
  await vacancy('lang_russian_c1', employer);
  await requireLanguage(
    'lang_russian_c1',
    await languageId(RUSSIAN),
    await levelC1(),
  );
  await vacancy('lang_english', employer);
  await requireLanguage('lang_english', await languageId(ENGLISH));

  mine = new Set(vacancies.values());
});

afterAll(async () => {
  for (const id of vacancies.values()) {
    await db
      .deleteFrom('vacancy_requirements')
      .where('vacancy_id', '=', id)
      .execute();
    await db.deleteFrom('vacancies').where('id', '=', id).execute();
  }

  for (const id of users) {
    await db.deleteFrom('employers').where('user_id', '=', id).execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

describe('§5.5 salaryTo', () => {
  it('excludes a vacancy whose floor is above the ceiling asked for', async () => {
    const names = await matching(candidate, { salaryTo: 2_000_000 });

    expect(names).not.toContain('pay_8m_to_10m');
  });

  it('keeps a vacancy whose range overlaps the ceiling', async () => {
    const names = await matching(candidate, { salaryTo: 1_500_000 });

    // Offers 1m-2m against a ceiling of 1.5m: the ranges overlap, so it is a
    // vacancy this candidate could take at the pay they asked for.
    expect(names).toContain('pay_1m_to_2m');
  });

  it('keeps a vacancy with no floor stated', async () => {
    const names = await matching(candidate, { salaryTo: 2_000_000 });

    // "Up to 3,000,000" might pay 2,000,000. Mirroring `salaryFrom` field for field
    // would have compared NULL and dropped it.
    expect(names).toContain('pay_up_to_3m');
  });

  it('keeps a negotiable vacancy, as the floor filter does', async () => {
    const names = await matching(candidate, { salaryTo: 500_000 });

    expect(names).toContain('pay_negotiable');
  });

  it('combines with salaryFrom into a two-sided range', async () => {
    const names = await matching(candidate, {
      salaryFrom: 1_500_000,
      salaryTo: 2_500_000,
    });

    expect(names).toContain('pay_1m_to_2m');
    expect(names).toContain('pay_up_to_3m');
    expect(names).not.toContain('pay_8m_to_10m');
  });
});

describe('§5.5 experienceYearsMax', () => {
  it('excludes a vacancy demanding more years than the candidate set', async () => {
    const names = await matching(candidate, { experienceYearsMax: 3 });

    expect(names).not.toContain('exp_10');
  });

  it('includes a vacancy demanding exactly the ceiling', async () => {
    const names = await matching(candidate, { experienceYearsMax: 3 });

    expect(names).toContain('exp_3');
  });

  it('includes a vacancy that states no experience requirement', async () => {
    const names = await matching(candidate, { experienceYearsMax: 0 });

    // Demands nothing, so it cannot demand more than nothing. An EXISTS-shaped
    // filter would have hidden every vacancy that left the field blank, which is
    // most of them.
    expect(names).toContain('exp_none');
  });

  it('is a ceiling, not an equality', async () => {
    const names = await matching(candidate, { experienceYearsMax: 5 });

    expect(names).toEqual(expect.arrayContaining(['exp_2', 'exp_3']));
    expect(names).not.toContain('exp_10');
  });
});

describe('§5.5 languageIds', () => {
  it('matches a vacancy requiring the language', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(RUSSIAN)],
    });

    expect(names).toContain('lang_russian');
  });

  it('ignores the level the vacancy asked for', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(RUSSIAN)],
    });

    // A vacancy wanting Russian at C1 is still a Russian vacancy to somebody
    // filtering for Russian-speaking work.
    expect(names).toContain('lang_russian_c1');
  });

  it('excludes a vacancy requiring a different language', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(RUSSIAN)],
    });

    expect(names).not.toContain('lang_english');
  });

  it('excludes a vacancy requiring no language at all', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(RUSSIAN)],
    });

    // The opposite polarity to `experienceYearsMax`, and deliberately: a language is
    // an attribute of the work, so "show me Russian-speaking work" cannot be
    // satisfied by a vacancy that never mentioned Russian.
    expect(names).not.toContain('lang_none');
  });

  it('treats several ids as any-of', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(RUSSIAN), await languageId(ENGLISH)],
    });

    expect(names).toEqual(
      expect.arrayContaining(['lang_english', 'lang_russian']),
    );
  });

  it('returns nothing for a language no fixture requires', async () => {
    const names = await matching(candidate, {
      languageIds: [await languageId(KOREAN)],
    });

    expect(names).toEqual([]);
  });
});

describe('§5.5 filters combine', () => {
  it('ANDs the three new filters with each other', async () => {
    // `lang_russian` has no pay and no experience requirement, so it passes both of
    // the other two - and is the only fixture that also requires Russian.
    const names = await matching(candidate, {
      salaryTo: 2_000_000,
      experienceYearsMax: 1,
      languageIds: [await languageId(RUSSIAN)],
    });

    expect(names.sort()).toEqual(['lang_russian', 'lang_russian_c1']);
  });

  it('narrows rather than replaces when added to an existing filter', async () => {
    const before = await matching(candidate, { experienceYearsMax: 10 });
    const after = await matching(candidate, {
      experienceYearsMax: 10,
      languageIds: [await languageId(ENGLISH)],
    });

    expect(before.length).toBeGreaterThan(after.length);
    expect(after).toEqual(['lang_english']);
  });
});
