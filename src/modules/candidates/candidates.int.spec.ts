import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';

import { CandidatesService } from './candidates.service';
import { HistoryService } from './history.service';

/**
 * Integration tests against a real Postgres.
 *
 * Run with `pnpm test:int`. None of this can be a unit test: BR-02's gate is
 * computed from six child tables, the one-primary-occupation rule is a partial
 * unique index, the attribute table's "exactly one value" rule is a CHECK, and the
 * privacy-toggle rule is about which of two timestamp columns a statement touches.
 * Over `DummyDriver` every one of these would compile, run nothing, and pass.
 *
 * Fixtures go in through the production write path - the service, not raw inserts -
 * so what is asserted is what a client would actually get.
 */

let db: Database;
let destroy: () => Promise<void>;
let candidates: CandidatesService;
let history: HistoryService;

/** Users created by this run, removed in afterAll (profiles cascade). */
const users: string[] = [];

const config = {
  get: (key: string) =>
    key === 'PLATFORM_TIME_ZONE'
      ? 'Asia/Tashkent'
      : key === 'FILE_MAX_SIZE_BYTES'
        ? 10_485_760
        : undefined,
} as unknown as ConfigService<never, true>;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());

  const dictionaries = new DictionariesService(db);
  const schemas = new SchemasService(db, dictionaries, config);
  const validator = new FieldValidatorService(dictionaries, config);

  candidates = new CandidatesService(db, schemas, validator);
  history = new HistoryService(db, candidates, config);
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function newCandidate(): Promise<string> {
  const phone = `+99893${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('user_roles')
    .values({ user_id: row.id, role: 'candidate' })
    .execute();

  users.push(row.id);
  return row.id;
}

/** A seeded dictionary id, by type and code - the real content, not a fixture. */
async function seededId(type: string, code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function anyId(
  type: string,
  where: (q: string) => boolean = () => true,
): Promise<string> {
  const rows = await db
    .selectFrom('dictionary_items')
    .select(['id', 'code', 'parent_id'])
    .where('type_code', '=', type)
    .where('is_active', '=', true)
    .execute();

  const row = rows.find((candidate) => where(candidate.code));

  if (!row) {
    throw new Error(`No seeded ${type} matched`);
  }

  return row.id;
}

/** The four fields every category requires, so a profile can reach BR-02's gate. */
async function requiredFields(): Promise<Record<string, unknown>> {
  const region = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'region')
    .where('parent_id', 'is', null)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  const district = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('parent_id', '=', region.id)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: region.id,
    district_id: district.id,
    primary_occupation_id: await anyId('occupation'),
  };
}

describe('CandidatesService', () => {
  it('reports an unstarted profile as empty rather than failing', async () => {
    const userId = await newCandidate();
    const profile = await candidates.read(userId);

    expect(profile.isStarted).toBe(false);
    expect(profile.completeness.percent).toBe(0);
    expect(profile.aggregate.row.visibility).toBe('hidden');
    // Every field of the common core is present and null, so the form renders.
    expect(profile.fields).toHaveProperty('full_name', null);
  });

  it('creates the profile on first write and derives the category from the occupation', async () => {
    const userId = await newCandidate();
    const occupation = await seededId('occupation', 'software_developer');

    const profile = await candidates.patch(userId, {
      full_name: 'Anvar Karimov',
      primary_occupation_id: occupation,
    });

    expect(profile.isStarted).toBe(true);
    expect(profile.aggregate.row.category).toBe('professional');
    // Stored, not only projected - §7.1 filters on it.
    const stored = await db
      .selectFrom('candidate_profiles')
      .select(['category', 'completeness_percent'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(stored.category).toBe('professional');
    expect(stored.completeness_percent).toBeGreaterThan(0);
  });

  it('refuses a category field before the category is known (§5.2)', async () => {
    const userId = await newCandidate();

    // `crew_size` exists only for physical and seasonal work, and nothing has said
    // which category this profile is yet.
    await expect(
      candidates.patch(userId, { full_name: 'Anvar', crew_size: 8 }),
    ).rejects.toThrow(ValidationFailedException);
  });

  it('accepts a category field once the occupation puts the profile in that category', async () => {
    const userId = await newCandidate();
    const cotton = await anyId('occupation', (code) => code.includes('cotton'));

    const profile = await candidates.patch(userId, {
      primary_occupation_id: cotton,
      crew_size: 8,
    });

    expect(profile.aggregate.row.category).toBe('seasonal_agricultural');
    expect(profile.fields.crew_size).toBe(8);
  });

  it('becomes searchable only when complete and visibility allows it (BR-02)', async () => {
    const userId = await newCandidate();

    const incomplete = await candidates.patch(userId, { full_name: 'Anvar' });
    expect(incomplete.completeness.isComplete).toBe(false);

    // Visibility may be enabled while incomplete: §5.3 gates the effect, not the
    // setting.
    const hidden = await candidates.setVisibility(userId, 'searchable');
    expect(hidden.aggregate.row.visibility).toBe('searchable');
    expect(hidden.completeness.isComplete).toBe(false);

    const complete = await candidates.patch(userId, await requiredFields());
    expect(complete.completeness.isComplete).toBe(true);

    const searchable = await db
      .selectFrom('candidate_profiles')
      .select(['is_complete', 'visibility'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(searchable.is_complete).toBe(true);
    expect(searchable.visibility).toBe('searchable');
  });

  it('does not move last_meaningful_update_at when only privacy changes (§5.3)', async () => {
    const userId = await newCandidate();
    const written = await candidates.patch(userId, { full_name: 'Anvar' });
    const meaningful = written.aggregate.row.last_meaningful_update_at;

    expect(meaningful).not.toBeNull();

    const toggled = await candidates.setVisibility(userId, 'hidden');

    // The whole point: a stale profile must not be able to look freshly maintained
    // by flipping a switch (§7.3 sorts by this).
    expect(toggled.aggregate.row.last_meaningful_update_at).toEqual(meaningful);
    expect(toggled.aggregate.row.updated_at?.getTime()).toBeGreaterThanOrEqual(
      written.aggregate.row.updated_at?.getTime() as number,
    );
  });

  it('keeps one primary occupation when the primary changes', async () => {
    const userId = await newCandidate();
    const first = await seededId('occupation', 'software_developer');
    const second = await seededId('occupation', 'backend_developer');

    await candidates.patch(userId, { primary_occupation_id: first });
    await candidates.patch(userId, { primary_occupation_id: second });

    const rows = await db
      .selectFrom('candidate_occupations')
      .select(['item_id', 'is_primary'])
      .where('user_id', '=', userId)
      .execute();

    // A partial unique index enforces this; the service has to satisfy it at every
    // point, not only at the end of the statement.
    expect(rows.filter((row) => row.is_primary)).toHaveLength(1);
    expect(rows.find((row) => row.is_primary)?.item_id).toBe(second);
  });

  it('keeps the primary occupation and its level when only the additional list is patched', async () => {
    const userId = await newCandidate();
    const primary = await seededId('occupation', 'software_developer');
    const extra = await seededId('occupation', 'frontend_developer');
    const level = await anyId('skill_level');

    await candidates.patch(userId, {
      primary_occupation_id: primary,
      occupation_level_id: level,
    });
    const patched = await candidates.patch(userId, {
      additional_occupation_ids: [extra],
    });

    expect(patched.fields.primary_occupation_id).toBe(primary);
    expect(patched.fields.occupation_level_id).toBe(level);
    expect(patched.fields.additional_occupation_ids).toEqual([extra]);
  });

  it('rewrites a leveled set wholesale, so removing an entry works', async () => {
    const userId = await newCandidate();
    const js = await seededId('skill', 'javascript');
    const ts = await seededId('skill', 'typescript');
    const level = await anyId('skill_level');

    await candidates.patch(userId, {
      skills: [
        { itemId: js, levelId: level },
        { itemId: ts, levelId: level },
      ],
    });
    const reduced = await candidates.patch(userId, {
      skills: [{ itemId: ts, levelId: level }],
    });

    expect(reduced.fields.skills).toEqual([{ itemId: ts, levelId: level }]);

    const rows = await db
      .selectFrom('candidate_skills')
      .select(['item_id', 'level_rank'])
      .where('user_id', '=', userId)
      .execute();

    expect(rows).toHaveLength(1);
    // The rank is copied from the level item, which is what makes a ">= level"
    // filter a range scan (ARCHITECTURE.md §5).
    expect(rows[0].level_rank).not.toBeNull();
  });

  it('stores a language’s certificate extras and its level rank', async () => {
    const userId = await newCandidate();
    const russian = await seededId('language', 'russian');
    const c1 = await seededId('language_level', 'c1');

    await candidates.patch(userId, {
      languages: [
        {
          itemId: russian,
          levelId: c1,
          has_certificate: true,
          certificate_note: 'TRKI-2',
        },
      ],
    });

    const row = await db
      .selectFrom('candidate_languages')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(row.has_certificate).toBe(true);
    expect(row.certificate_note).toBe('TRKI-2');
    // §7.4's controlled example is "Russian at C1", so the rank must be comparable.
    expect(row.level_rank).toBeGreaterThan(0);
  });

  it('stores a multi-select attribute as one row per id, and clears it on an empty list', async () => {
    const userId = await newCandidate();
    const fullTime = await seededId('employment_type', 'full_time');
    const partTime = await seededId('employment_type', 'part_time');

    await candidates.patch(userId, {
      employment_type_ids: [fullTime, partTime],
    });

    const rows = await db
      .selectFrom('candidate_attributes')
      .select('item_id')
      .where('user_id', '=', userId)
      .where('field_code', '=', 'employment_type_ids')
      .execute();

    expect(rows).toHaveLength(2);

    const cleared = await candidates.patch(userId, { employment_type_ids: [] });
    expect(cleared.fields.employment_type_ids).toEqual([]);

    const after = await db
      .selectFrom('candidate_attributes')
      .select('item_id')
      .where('user_id', '=', userId)
      .where('field_code', '=', 'employment_type_ids')
      .execute();

    expect(after).toHaveLength(0);
  });

  it('round-trips a money range through its four columns', async () => {
    const userId = await newCandidate();
    const monthly = await seededId('payment_period', 'monthly');

    const profile = await candidates.patch(userId, {
      salary: {
        from: 5_000_000,
        to: 8_000_000,
        periodId: monthly,
        isNegotiable: false,
      },
    });

    expect(profile.fields.salary).toEqual({
      from: 5_000_000,
      to: 8_000_000,
      periodId: monthly,
      currency: 'UZS',
      isNegotiable: false,
    });
  });

  it('refuses a negotiable salary that also names an amount, before writing anything', async () => {
    const userId = await newCandidate();
    await candidates.patch(userId, { full_name: 'Anvar' });

    await expect(
      candidates.patch(userId, {
        full_name: 'Changed',
        salary: { from: 1_000, isNegotiable: true },
      }),
    ).rejects.toThrow(ValidationFailedException);

    // Validation runs before the transaction opens, so the valid field in the same
    // body was not written either - the request failed as a whole.
    const row = await db
      .selectFrom('candidate_profiles')
      .select('full_name')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(row.full_name).toBe('Anvar');
  });

  it('keeps a calendar date exactly as sent, with no zone shift', async () => {
    const userId = await newCandidate();

    const profile = await candidates.patch(userId, {
      date_of_birth: '1996-04-12',
    });

    // The trap this guards: a `date` parsed into a local-midnight Date and then
    // rendered in another zone comes back a day earlier.
    expect(profile.fields.date_of_birth).toBe('1996-04-12');

    const row = await db
      .selectFrom('candidate_profiles')
      .select('date_of_birth')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(row.date_of_birth).toBe('1996-04-12');
  });

  it('refuses an unknown field code rather than silently dropping it', async () => {
    const userId = await newCandidate();

    await expect(
      candidates.patch(userId, { not_a_field: 'x' }),
    ).rejects.toThrow(ValidationFailedException);
  });
});

describe('HistoryService', () => {
  it('creates the profile row when experience is added first', async () => {
    const userId = await newCandidate();

    const record = await history.addExperience(userId, {
      roleTitle: 'Operator',
      startedOn: '2024-01-15',
    });

    expect(record.id).toBeTruthy();
    // Every child table references candidate_profiles, so "fill in your name
    // first" would otherwise be an accidental rule.
    expect((await candidates.read(userId)).isStarted).toBe(true);
  });

  it('counts experience toward completeness, in the same transaction', async () => {
    const userId = await newCandidate();
    await candidates.patch(userId, { full_name: 'Anvar' });
    const before = await candidates.read(userId);

    await history.addExperience(userId, {
      roleTitle: 'Operator',
      startedOn: '2024-01-15',
      employerName: 'Call centre',
    });

    const after = await candidates.read(userId);

    expect(after.completeness.percent).toBeGreaterThan(
      before.completeness.percent,
    );
    // Stored too, or search would disagree with the profile screen.
    const row = await db
      .selectFrom('candidate_profiles')
      .select('completeness_percent')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.completeness_percent).toBe(after.completeness.percent);
  });

  it('refuses a current role with an end date, and an end before the start', async () => {
    const userId = await newCandidate();

    await expect(
      history.addExperience(userId, {
        roleTitle: 'Operator',
        startedOn: '2024-01-15',
        endedOn: '2024-06-01',
        isCurrent: true,
      }),
    ).rejects.toThrow(ValidationFailedException);

    await expect(
      history.addExperience(userId, {
        roleTitle: 'Operator',
        startedOn: '2024-06-01',
        endedOn: '2024-01-15',
      }),
    ).rejects.toThrow(ValidationFailedException);
  });

  it('never lets one candidate touch another’s record', async () => {
    const owner = await newCandidate();
    const other = await newCandidate();
    const record = await history.addExperience(owner, {
      roleTitle: 'Operator',
      startedOn: '2024-01-15',
    });

    await expect(
      history.updateExperience(other, record.id, {
        roleTitle: 'Hijacked',
        startedOn: '2024-01-15',
      }),
    ).rejects.toThrow();

    await expect(history.removeExperience(other, record.id)).rejects.toThrow();

    // Still the owner's, and unchanged.
    const items = await history.listExperience(owner);
    expect(items).toHaveLength(1);
    expect(items[0].roleTitle).toBe('Operator');
  });

  it('reports a missing record as not found', async () => {
    const userId = await newCandidate();

    await expect(
      history.removeExperience(userId, randomUUID()),
    ).rejects.toThrow();
  });

  it('deletes education and refreshes completeness afterwards', async () => {
    const userId = await newCandidate();
    const level = await anyId('education_level');

    const record = await history.addEducation(userId, {
      levelId: level,
      institution: 'TUIT',
      specialization: 'Software engineering',
      graduationYear: 2018,
    });

    const withEducation = await candidates.read(userId);
    await history.removeEducation(userId, record.id);
    const without = await candidates.read(userId);

    expect(without.completeness.percent).toBeLessThan(
      withEducation.completeness.percent,
    );
    expect(await history.listEducation(userId)).toHaveLength(0);
  });

  it('removes every child row when the account is deleted', async () => {
    const userId = await newCandidate();
    await candidates.patch(userId, {
      full_name: 'Anvar',
      skills: [
        {
          itemId: await seededId('skill', 'javascript'),
          levelId: await anyId('skill_level'),
        },
      ],
    });
    await history.addExperience(userId, {
      roleTitle: 'Operator',
      startedOn: '2024-01-15',
    });

    await db.deleteFrom('users').where('id', '=', userId).execute();

    // Cascades through candidate_profiles: a child row surviving its profile would
    // be unreachable data referencing a user who no longer exists (BR-14).
    for (const table of [
      'candidate_profiles',
      'candidate_skills',
      'candidate_experience',
    ] as const) {
      const rows = await db
        .selectFrom(table)
        .select('user_id')
        .where('user_id', '=', userId)
        .execute();

      expect(rows).toHaveLength(0);
    }
  });
});
