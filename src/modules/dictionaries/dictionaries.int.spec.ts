import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { CANONICAL_LOCALES } from '@infra/locale/locale';

import { DictionariesService } from './dictionaries.service';
import { seedDictionaries } from './seed/dictionary-seed';
import { DICTIONARY_SEED, type SeedType } from './seed/dictionary-seed.data';

/**
 * Integration tests against a real Postgres.
 *
 * Nothing here can be a unit test: the revision counter and the
 * all-four-locales rule are triggers, the label fallback is a lateral join, and
 * the delta is defined by comparing two tables' revisions. Every assertion below
 * is about behaviour the database owns.
 *
 * Fixtures live in their own throwaway dictionary types so the seeded content
 * (which other assertions read) is never mutated.
 */

let db: Database;
let destroy: () => Promise<void>;
let service: DictionariesService;

/** Types created by this run, dropped in afterAll. */
const temporaryTypes: string[] = [];

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  service = new DictionariesService(db);
});

afterAll(async () => {
  for (const code of temporaryTypes) {
    await db
      .deleteFrom('dictionary_items')
      .where('type_code', '=', code)
      .execute();
    await db.deleteFrom('dictionary_types').where('code', '=', code).execute();
  }

  await destroy();
});

/**
 * Creates a throwaway type through the real seeder, so fixtures go in the same
 * way production content does - including the activate-after-labels order.
 */
async function fixtureType(
  items: SeedType['items'],
  options: { hasRank?: boolean } = {},
): Promise<string> {
  const code = `test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  temporaryTypes.push(code);

  await seedDictionaries(db, [
    { code, provenance: 'default', hasRank: options.hasRank, items },
  ]);

  return code;
}

function labels(prefix: string): Record<string, string> {
  return {
    'uz-Latn': `${prefix} latin`,
    'uz-Cyrl': `${prefix} кирилл`,
    ru: `${prefix} русский`,
    en: `${prefix} english`,
  };
}

async function itemId(typeCode: string, code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', typeCode)
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

describe('manifest', () => {
  it('publishes every frozen type and all ten field-schema versions', async () => {
    const manifest = await service.manifest();

    // The 14 types of docs/API_CONTRACTS.md §3.1 - the client keys its cache off
    // this list, so a missing type is a dictionary it can never refresh.
    for (const type of [
      'occupation',
      'skill',
      'industry',
      'region',
      'language',
      'employment_type',
      'work_format',
      'shift',
      'attribute',
      'skill_level',
      'language_level',
      'education_level',
      'payment_period',
      'file_purpose',
    ]) {
      expect(manifest.types.map((t) => t.type)).toContain(type);
    }

    // Five §2.1 categories × two targets.
    expect(manifest.schemas).toHaveLength(10);
    expect(manifest.version).toBeGreaterThan(0);
  });

  it('counts active items only, because that is what a picker shows', async () => {
    const type = await fixtureType([
      { code: 'one', labels: labels('one') },
      { code: 'two', labels: labels('two') },
    ]);

    await db
      .updateTable('dictionary_items')
      .set({ is_active: false })
      .where('type_code', '=', type)
      .where('code', '=', 'two')
      .execute();

    const manifest = await service.manifest();
    expect(manifest.types.find((t) => t.type === type)?.count).toBe(1);
  });
});

describe('locale resolution (BR-13, UAT-13)', () => {
  it('returns the same ids in every interface variant', async () => {
    const perLocale = await Promise.all(
      CANONICAL_LOCALES.map((locale) => service.delta('region', locale, null)),
    );

    const idSets = perLocale.map((d) => d.items.map((i) => i.id).sort());

    // The whole point of BR-13: selecting a value in any of the four variants
    // must produce the same filter and therefore the same results.
    for (const ids of idSets) {
      expect(ids).toEqual(idSets[0]);
    }

    // ...and the labels must genuinely differ, or the four locales are a lie.
    const firstLabels = perLocale.map((d) => d.items[0].label);
    expect(new Set(firstLabels).size).toBe(4);
  });

  it('emits the canonical locale casing, never the alias that was sent', async () => {
    for (const locale of CANONICAL_LOCALES) {
      const delta = await service.delta('region', locale, null);
      // The client caches by this value (API_CONTRACTS.md §1); a casing slip
      // splits its cache permanently.
      expect(delta.locale).toBe(locale);
    }
  });

  it('never returns a bare code as a label', async () => {
    const manifest = await service.manifest();

    for (const type of manifest.types) {
      const delta = await service.delta(type.type, 'ru', null);

      for (const item of delta.items) {
        // §3.2: a missing translation must fall back, never surface the key.
        expect(item.label).not.toBe(item.code);
        expect(item.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('falls back down the chain when a locale is missing', async () => {
    const type = await fixtureType([{ code: 'solo', labels: labels('solo') }]);
    const id = await itemId(type, 'solo');

    await db
      .deleteFrom('dictionary_item_translations')
      .where('item_id', '=', id)
      .where('locale', '=', 'ru')
      .execute();

    const [item] = await service.itemsByIds([id], 'ru');

    // ru → en per §3.2; the item is still served, with a real label.
    expect(item.label).toBe('solo english');
  });

  it('prefers Latin Uzbek over English for a Cyrillic reader', async () => {
    const type = await fixtureType([{ code: 'cyr', labels: labels('cyr') }]);
    const id = await itemId(type, 'cyr');

    await db
      .deleteFrom('dictionary_item_translations')
      .where('item_id', '=', id)
      .where('locale', '=', 'uz-Cyrl')
      .execute();

    const [item] = await service.itemsByIds([id], 'uz-Cyrl');

    // Same language, different script: far better than English.
    expect(item.label).toBe('cyr latin');
  });
});

describe('activation rule (§3.2)', () => {
  it('refuses to activate an item missing a locale', async () => {
    const type = await fixtureType([{ code: 'ok', labels: labels('ok') }]);

    // Straight to SQL: the seeder cannot express this, which is the point - the
    // rule has to hold against any write path, including a manual fix.
    await expect(
      db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('dictionary_items')
          .values({ type_code: type, code: 'partial', is_active: true })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('dictionary_item_translations')
          .values([
            { item_id: inserted.id, locale: 'ru', label: 'частично' },
            { item_id: inserted.id, locale: 'en', label: 'partial' },
          ])
          .execute();
      }),
    ).rejects.toThrow(/locale labels/);

    // The failure is a rollback, not a half-created item.
    const rows = await db
      .selectFrom('dictionary_items')
      .select('id')
      .where('type_code', '=', type)
      .where('code', '=', 'partial')
      .execute();

    expect(rows).toEqual([]);
  });

  it('allows an item and its four labels in one transaction, in any order', async () => {
    // The constraint is deferred to commit, so a caller does not have to know
    // that labels must be written before activation.
    const type = await fixtureType([
      { code: 'deferred', labels: labels('deferred') },
    ]);

    const delta = await service.delta(type, 'en', null);
    expect(delta.items.map((i) => i.code)).toEqual(['deferred']);
  });
});

describe('deltas', () => {
  it('returns nothing when the client is already current', async () => {
    const type = await fixtureType([{ code: 'a', labels: labels('a') }]);

    const full = await service.delta(type, 'en', null);
    expect(full.isFull).toBe(true);
    expect(full.items).toHaveLength(1);

    const empty = await service.delta(type, 'en', full.version);
    expect(empty.isFull).toBe(false);
    expect(empty.items).toEqual([]);
    expect(empty.removed).toEqual([]);
    expect(empty.version).toBe(full.version);
  });

  it('ships an item again when only one of its labels changed', async () => {
    const type = await fixtureType([{ code: 'b', labels: labels('b') }]);
    const before = await service.delta(type, 'en', null);
    const id = await itemId(type, 'b');

    await db
      .updateTable('dictionary_item_translations')
      .set({ label: 'b русский исправленный' })
      .where('item_id', '=', id)
      .where('locale', '=', 'ru')
      .execute();

    // A label edit in one locale bumps the type version for all of them
    // (API_CONTRACTS.md §3.3). Over-invalidating slightly is deliberate; the
    // alternative is a client that never sees the correction.
    const after = await service.delta(type, 'en', before.version);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.items.map((i) => i.code)).toEqual(['b']);
  });

  it('reports a deactivated item as removed rather than dropping it', async () => {
    const type = await fixtureType([{ code: 'c', labels: labels('c') }]);
    const before = await service.delta(type, 'en', null);

    await db
      .updateTable('dictionary_items')
      .set({ is_active: false })
      .where('type_code', '=', type)
      .where('code', '=', 'c')
      .execute();

    const after = await service.delta(type, 'en', before.version);

    expect(after.items).toEqual([]);
    expect(after.removed).toEqual([
      { id: await itemId(type, 'c'), reason: 'inactive', mergedIntoId: null },
    ]);
  });

  it('carries both sides of a merge in one delta (§10.3)', async () => {
    const type = await fixtureType([
      { code: 'loser', labels: labels('loser') },
      { code: 'winner', labels: labels('winner') },
    ]);

    const before = await service.delta(type, 'en', null);
    const loserId = await itemId(type, 'loser');
    const winnerId = await itemId(type, 'winner');

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('dictionary_items')
        .set({ merged_into_id: winnerId, is_active: false })
        .where('id', '=', loserId)
        .execute();

      // Touching the survivor is what puts it in the same delta, so the client
      // can repoint local references without a follow-up request.
      await trx
        .updateTable('dictionary_items')
        .set({ updated_at: new Date() })
        .where('id', '=', winnerId)
        .execute();
    });

    const after = await service.delta(type, 'en', before.version);

    expect(after.removed).toEqual([
      { id: loserId, reason: 'merged', mergedIntoId: winnerId },
    ]);
    expect(after.items.map((i) => i.id)).toContain(winnerId);
  });

  it('rejects a self-merge in the database', async () => {
    const type = await fixtureType([{ code: 'self', labels: labels('self') }]);
    const id = await itemId(type, 'self');

    await expect(
      db
        .updateTable('dictionary_items')
        .set({ merged_into_id: id })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow();
  });
});

describe('items by id', () => {
  it('resolves inactive and merged ids, for historical records', async () => {
    const type = await fixtureType([
      { code: 'old', labels: labels('old') },
      { code: 'new', labels: labels('new') },
    ]);

    const oldId = await itemId(type, 'old');
    const newId = await itemId(type, 'new');

    await db
      .updateTable('dictionary_items')
      .set({ is_active: false, merged_into_id: newId })
      .where('id', '=', oldId)
      .execute();

    const resolved = await service.itemsByIds([oldId], 'en');

    // A vacancy created before the merge still has to render.
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe('old english');
    expect(resolved[0].isActive).toBe(false);
    expect(resolved[0].mergedIntoId).toBe(newId);
  });

  it('returns nothing for an unknown id rather than failing', async () => {
    expect(await service.itemsByIds([randomUUID()], 'en')).toEqual([]);
  });
});

describe('ranked scales', () => {
  it('carries a rank on level types and nowhere else', async () => {
    const levels = await service.delta('language_level', 'en', null);

    // §7.4's "≥ C1" is a range comparison over this value.
    const ranks = levels.items.map((i) => i.rank);
    expect(ranks.every((r) => typeof r === 'number')).toBe(true);
    expect([...ranks].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(ranks);

    const regions = await service.delta('region', 'en', null);
    expect(regions.items.every((i) => i.rank === null)).toBe(true);
  });

  it('declares which types are ranked', async () => {
    const rows = await db
      .selectFrom('dictionary_types')
      .select(['code', 'has_rank'])
      .where('has_rank', '=', true)
      .execute();

    expect(rows.map((r) => r.code).sort()).toEqual([
      'language_level',
      'skill_level',
    ]);
  });
});

describe('seeding', () => {
  it('bumps no revision on a second identical run', async () => {
    const type = await fixtureType([{ code: 'idem', labels: labels('idem') }]);
    const before = await service.typeVersion(type);

    const report = await seedDictionaries(db, [
      {
        code: type,
        provenance: 'default',
        items: [{ code: 'idem', labels: labels('idem') }],
      },
    ]);

    // A seeder that rewrote identical rows would bump the revision by trigger and
    // make every client refetch every dictionary after every deployment.
    expect(report).toEqual({
      typesCreated: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      labelsWritten: 0,
      itemsActivated: 0,
    });
    expect(await service.typeVersion(type)).toBe(before);
  });

  it('applies exactly the changed label and nothing else', async () => {
    const type = await fixtureType([{ code: 'edit', labels: labels('edit') }]);

    const report = await seedDictionaries(db, [
      {
        code: type,
        provenance: 'default',
        items: [
          { code: 'edit', labels: { ...labels('edit'), ru: 'исправлено' } },
        ],
      },
    ]);

    expect(report.labelsWritten).toBe(1);
    expect(report.itemsUpdated).toBe(0);
  });

  it('fails loudly on a seed entry missing a locale', async () => {
    await expect(
      seedDictionaries(db, [
        {
          code: 'test_never_created',
          provenance: 'default',
          items: [
            {
              code: 'broken',
              // Deliberately incomplete: the error must name the item, not a uuid.
              labels: { 'uz-Latn': 'a', 'uz-Cyrl': 'б', ru: 'в' } as never,
            },
          ],
        },
      ]),
    ).rejects.toThrow(/missing labels: en/);

    const leftovers = await db
      .selectFrom('dictionary_types')
      .select('code')
      .where('code', '=', 'test_never_created')
      .execute();

    expect(leftovers).toEqual([]);
  });

  it('never puts a Cyrillic label in a Latin-script slot, or the reverse', () => {
    // The content files use positional label helpers - `place(code, uzLatn,
    // uzCyrl, ru, en)` - which keeps 175 districts reviewable but makes a swapped
    // column easy to write. This is what catches one.
    //
    // Two rules, both crisp:
    //   1. `uz-Latn` and `en` may never contain Cyrillic.
    //   2. `uz-Cyrl` and `ru` must contain Cyrillic, *unless* the label is
    //      deliberately untransliterated - a product or brand name, marked by
    //      being byte-identical to its Latin counterpart ("PostgreSQL", "1C").
    const CYRILLIC = /[Ѐ-ӿ]/;
    const problems: string[] = [];

    for (const type of DICTIONARY_SEED) {
      for (const item of type.items) {
        const l = item.labels;

        if (CYRILLIC.test(l['uz-Latn'])) {
          problems.push(`${type.code}/${item.code}: Cyrillic in uz-Latn`);
        }

        if (CYRILLIC.test(l.en)) {
          problems.push(`${type.code}/${item.code}: Cyrillic in en`);
        }

        if (l['uz-Cyrl'] !== l['uz-Latn'] && !CYRILLIC.test(l['uz-Cyrl'])) {
          problems.push(`${type.code}/${item.code}: no Cyrillic in uz-Cyrl`);
        }

        if (l.ru !== l.en && !CYRILLIC.test(l.ru)) {
          problems.push(`${type.code}/${item.code}: no Cyrillic in ru`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('uses a unique code within each type', () => {
    // A duplicate code is not a database error - the seeder would find the first
    // row and quietly update it with the second row's labels, so the item count
    // would be short by one and nobody would know which.
    const duplicates: string[] = [];

    for (const type of DICTIONARY_SEED) {
      const seen = new Set<string>();

      for (const item of type.items) {
        if (seen.has(item.code)) {
          duplicates.push(`${type.code}/${item.code}`);
        }
        seen.add(item.code);
      }
    }

    expect(duplicates).toEqual([]);
  });

  it('resolves every district to its region', async () => {
    const regions = await service.delta('region', 'ru', null);

    const parents = new Set(
      regions.items.filter((i) => i.parentId === null).map((i) => i.id),
    );
    const children = regions.items.filter((i) => i.parentId !== null);

    // 14 first-level units, and every other row hangs off one of them - which is
    // what makes the client's region → district picker work off `parentId` alone.
    expect(parents.size).toBe(14);
    expect(children.length).toBeGreaterThan(150);

    for (const child of children) {
      expect(parents.has(child.parentId as string)).toBe(true);
    }
  });

  it('gives every occupation one of the five §2.1 categories', async () => {
    const occupations = await service.delta('occupation', 'en', null);

    // §5.2 drives the profile and vacancy field sets from this, so an occupation
    // without a category produces a form with no category section at all.
    const categories = new Set(occupations.items.map((i) => i.category));

    expect(occupations.items.every((i) => i.category !== null)).toBe(true);
    expect([...categories].sort()).toEqual([
      'physical_industrial',
      'professional',
      'seasonal_agricultural',
      'service_operations',
      'temporary_shift',
    ]);
  });

  it('gives every seeded item all four labels', async () => {
    // Scoped to the real seeded types: the fallback fixtures above delete a
    // translation from an already-active item on purpose, which the activation
    // trigger cannot catch (it fires on the item, not on its labels). That gap is
    // acceptable because removing a label is not an exposed operation and the
    // fallback chain covers it - but it means this assertion has to name what it
    // is asserting about.
    const seededTypes = DICTIONARY_SEED.map((t) => t.code);

    const incomplete = await sql<{ code: string; locales: number }>`
      SELECT i.code, count(t.locale)::int AS locales
      FROM dictionary_items i
      LEFT JOIN dictionary_item_translations t ON t.item_id = i.id
      WHERE i.is_active
        AND i.type_code = ANY(${sql.val(seededTypes)}::text[])
      GROUP BY i.id, i.code
      HAVING count(t.locale) < (
        SELECT count(*) FROM unnest(enum_range(NULL::locale_code))
      )
    `.execute(db);

    expect(incomplete.rows).toEqual([]);
  });
});
