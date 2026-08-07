import type { DictionaryItemFacts } from '@modules/dictionaries/dictionaries.service';

import { parseField } from './field-validator';
import type { SchemaField } from './schema-types';

/**
 * The write-side rules of API_CONTRACTS.md §4.
 *
 * Pure by construction - dictionary facts are passed in - so these run without a
 * database and cover the cases a live request would only reach by accident: a
 * deactivated id still offered by a stale client cache, a district under the wrong
 * region, a negotiable salary that also names an amount.
 */

const LABELS = { 'uz-Latn': 'x', 'uz-Cyrl': 'x', ru: 'x', en: 'x' };
const TODAY = '2026-08-05';

function facts(
  ...items: Partial<DictionaryItemFacts>[]
): Map<string, DictionaryItemFacts> {
  const map = new Map<string, DictionaryItemFacts>();

  for (const item of items) {
    const full: DictionaryItemFacts = {
      id: item.id as string,
      typeCode: item.typeCode ?? 'skill',
      group: item.group ?? null,
      category: item.category ?? null,
      parentId: item.parentId ?? null,
      rank: item.rank ?? null,
      isActive: item.isActive ?? true,
      mergedIntoId: item.mergedIntoId ?? null,
    };
    map.set(full.id, full);
  }

  return map;
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const LEVEL = '33333333-3333-4333-8333-333333333333';

function parse(
  field: Partial<SchemaField>,
  raw: unknown,
  known = facts(),
  stored = new Map<string, string | null>(),
) {
  return parseField(
    {
      code: 'field',
      kind: 'text',
      labels: LABELS,
      storage: { kind: 'attribute' },
      ...field,
    },
    raw,
    known,
    { stored, today: TODAY },
  );
}

describe('parseField', () => {
  describe('clearing a value', () => {
    it.each([null, undefined, ''])('treats %p as cleared', (raw) => {
      const result = parse({ kind: 'text' }, raw);

      expect(result.violations).toEqual([]);
      expect(result.value).toEqual({ type: 'scalar', value: null });
    });

    it('clears a required field, because requiredness gates search and not the save', () => {
      const result = parse({ kind: 'text', requiredIn: 'all' }, null);

      expect(result.violations).toEqual([]);
    });

    it('clears a list to an empty list rather than null', () => {
      // The write path deletes the rows for the field; a null would be ambiguous.
      expect(parse({ kind: 'dictionary_multi' }, null).value).toEqual({
        type: 'ids',
        value: [],
      });
      expect(parse({ kind: 'dictionary_leveled' }, null).value).toEqual({
        type: 'leveled',
        value: [],
      });
    });
  });

  describe('text', () => {
    it('trims, and a blank string clears', () => {
      expect(parse({ kind: 'text' }, '  Anvar  ').value).toEqual({
        type: 'scalar',
        value: 'Anvar',
      });
      expect(parse({ kind: 'text' }, '   ').value).toEqual({
        type: 'scalar',
        value: null,
      });
    });

    it('enforces the declared bounds', () => {
      const field = {
        kind: 'text' as const,
        validation: { minLength: 3, maxLength: 5 },
      };

      expect(parse(field, 'ab').violations[0]).toMatchObject({
        rule: 'minLength',
        messageKey: 'validation.too_short',
        params: { min: 3 },
      });
      expect(parse(field, 'abcdef').violations[0]).toMatchObject({
        rule: 'maxLength',
        params: { max: 5 },
      });
    });

    it('refuses a non-string', () => {
      expect(parse({ kind: 'text' }, 42).violations[0]).toMatchObject({
        messageKey: 'validation.must_be_text',
      });
    });
  });

  describe('url', () => {
    it('accepts http and https', () => {
      expect(parse({ kind: 'url' }, 'https://a.uz/cv').violations).toEqual([]);
    });

    it.each(['javascript:alert(1)', 'data:text/html,x', 'not a url'])(
      'refuses %p',
      (raw) => {
        // A portfolio link is rendered as tappable, so the scheme is checked here
        // and not only in the client.
        expect(parse({ kind: 'url' }, raw).violations[0]).toMatchObject({
          messageKey: 'validation.must_be_url',
        });
      },
    );
  });

  describe('int', () => {
    it('enforces min and max', () => {
      const field = { kind: 'int' as const, validation: { min: 1, max: 200 } };

      expect(parse(field, 0).violations[0]).toMatchObject({ rule: 'min' });
      expect(parse(field, 201).violations[0]).toMatchObject({ rule: 'max' });
      expect(parse(field, 12).value).toEqual({ type: 'scalar', value: 12 });
    });

    it('refuses a fractional value and a numeric string', () => {
      expect(parse({ kind: 'int' }, 1.5).violations[0]).toMatchObject({
        messageKey: 'validation.must_be_integer',
      });
      expect(parse({ kind: 'int' }, '12').violations[0]).toMatchObject({
        messageKey: 'validation.must_be_integer',
      });
    });
  });

  describe('date', () => {
    it('accepts an ISO calendar date and keeps it a string', () => {
      expect(parse({ kind: 'date' }, '2026-08-12').value).toEqual({
        type: 'scalar',
        value: '2026-08-12',
      });
    });

    it.each(['12-08-2026', '2026-8-12', '2026-02-31', '2026-08-12T00:00:00Z'])(
      'refuses %p',
      (raw) => {
        expect(parse({ kind: 'date' }, raw).violations[0]).toMatchObject({
          messageKey: 'validation.must_be_date',
        });
      },
    );

    it('refuses a future date when the field says notAfter today', () => {
      const field = {
        kind: 'date' as const,
        validation: { notAfter: 'today' as const },
      };

      expect(parse(field, '2026-08-06').violations[0]).toMatchObject({
        messageKey: 'validation.date_in_future',
      });
      expect(parse(field, TODAY).violations).toEqual([]);
    });

    it('enforces a minimum age against the injected today', () => {
      const field = { kind: 'date' as const, validation: { minAgeYears: 14 } };

      expect(parse(field, '2012-08-06').violations[0]).toMatchObject({
        messageKey: 'validation.min_age',
        params: { min: 14 },
      });
      // Exactly 14 today is old enough.
      expect(parse(field, '2012-08-05').violations).toEqual([]);
    });
  });

  describe('money_range', () => {
    const field = {
      kind: 'money_range' as const,
      periodDictionaryType: 'payment_period',
      validation: { min: 0, max: 1_000_000, requireFromLteTo: true },
    };
    const period = facts({ id: ID_A, typeCode: 'payment_period' });

    it('accepts a range with a period', () => {
      const result = parse(
        field,
        { from: 100, to: 200, periodId: ID_A, isNegotiable: false },
        period,
      );

      expect(result.violations).toEqual([]);
      expect(result.value).toEqual({
        type: 'money',
        value: { from: 100, to: 200, periodId: ID_A, isNegotiable: false },
      });
    });

    it('accepts a one-sided range', () => {
      expect(parse(field, { from: 100, to: null }, period).violations).toEqual(
        [],
      );
    });

    it('refuses from greater than to', () => {
      expect(
        parse(field, { from: 200, to: 100 }, period).violations[0],
      ).toMatchObject({
        rule: 'requireFromLteTo',
        messageKey: 'validation.salary_range_order',
      });
    });

    it('refuses negotiable together with an amount', () => {
      // §4.3: a contradiction the salary filter cannot rank, so it is rejected
      // rather than normalized - dropping half would store something unsaid.
      expect(
        parse(field, { from: 100, isNegotiable: true }, period).violations[0],
      ).toMatchObject({
        messageKey: 'validation.salary_negotiable_excludes_range',
      });
    });

    it('accepts negotiable on its own', () => {
      expect(parse(field, { isNegotiable: true }, period).violations).toEqual(
        [],
      );
    });

    it('refuses a period id from another dictionary type', () => {
      expect(
        parse(
          field,
          { from: 1, periodId: ID_B },
          facts({ id: ID_B, typeCode: 'shift' }),
        ).violations[0],
      ).toMatchObject({ field: 'field.periodId' });
    });
  });

  describe('dictionary_single', () => {
    const field = {
      kind: 'dictionary_single' as const,
      dictionaryType: 'region',
    };

    it('accepts an active item of the declared type', () => {
      expect(
        parse(field, ID_A, facts({ id: ID_A, typeCode: 'region' })).violations,
      ).toEqual([]);
    });

    it('refuses a malformed id', () => {
      expect(parse(field, 'nope').violations[0]).toMatchObject({
        messageKey: 'validation.must_be_id',
      });
    });

    it.each([
      ['unknown', facts()],
      ['inactive', facts({ id: ID_A, typeCode: 'region', isActive: false })],
      ['merged', facts({ id: ID_A, typeCode: 'region', mergedIntoId: ID_B })],
      ['of another type', facts({ id: ID_A, typeCode: 'skill' })],
    ])('refuses an %s item', (_name, known) => {
      // Inactive and merged items still resolve on a *read* - that is why they are
      // never deleted - but must not be selectable in a new write (§3.2, §10.3).
      expect(parse(field, ID_A, known).violations[0]).toMatchObject({
        messageKey: 'validation.dictionary_item_invalid',
      });
    });

    it('refuses an item outside the parent chosen in another field', () => {
      const result = parse(
        { ...field, parentFieldCode: 'region_id' },
        ID_A,
        facts({ id: ID_A, typeCode: 'region', parentId: ID_B }),
        new Map([['region_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]),
      );

      expect(result.violations[0]).toMatchObject({
        messageKey: 'validation.district_not_in_region',
      });
    });

    it('accepts an item under the stored parent, which the request need not resend', () => {
      const result = parse(
        { ...field, parentFieldCode: 'region_id' },
        ID_A,
        facts({ id: ID_A, typeCode: 'region', parentId: ID_B }),
        new Map([['region_id', ID_B]]),
      );

      expect(result.violations).toEqual([]);
    });

    it('accepts any parent when none is stored yet', () => {
      const result = parse(
        { ...field, parentFieldCode: 'region_id' },
        ID_A,
        facts({ id: ID_A, typeCode: 'region', parentId: ID_B }),
        new Map([['region_id', null]]),
      );

      expect(result.violations).toEqual([]);
    });
  });

  describe('dictionary_multi', () => {
    const field = {
      kind: 'dictionary_multi' as const,
      dictionaryType: 'attribute',
      group: 'tools',
      validation: { maxItems: 2 },
    };
    const tools = facts(
      { id: ID_A, typeCode: 'attribute', group: 'tools' },
      { id: ID_B, typeCode: 'attribute', group: 'transport' },
    );

    it('refuses an item from another group of the same type', () => {
      // A field asks for one `item_group` (§3.4); accepting a vehicle as a tool
      // would put it in the wrong filter.
      expect(parse(field, [ID_B], tools).violations[0]).toMatchObject({
        messageKey: 'validation.dictionary_item_invalid',
      });
    });

    it('deduplicates rather than rejecting a repeated id', () => {
      const result = parse(field, [ID_A, ID_A], tools);

      expect(result.violations).toEqual([]);
      expect(result.value).toEqual({ type: 'ids', value: [ID_A] });
    });

    it('counts items after deduplication against maxItems', () => {
      expect(parse(field, [ID_A, ID_A, ID_A], tools).violations).toEqual([]);
    });

    it('refuses more than maxItems', () => {
      const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const known = facts(
        { id: ID_A, typeCode: 'attribute', group: 'tools' },
        { id: third, typeCode: 'attribute', group: 'tools' },
        { id: LEVEL, typeCode: 'attribute', group: 'tools' },
      );

      expect(
        parse(field, [ID_A, third, LEVEL], known).violations[0],
      ).toMatchObject({
        messageKey: 'validation.too_many_items',
        params: { max: 2 },
      });
    });

    it('refuses a non-list', () => {
      expect(parse(field, ID_A, tools).violations[0]).toMatchObject({
        messageKey: 'validation.must_be_list',
      });
    });
  });

  describe('dictionary_leveled', () => {
    const field = {
      kind: 'dictionary_leveled' as const,
      dictionaryType: 'language',
      levelDictionaryType: 'language_level',
      extras: [
        { code: 'has_certificate', kind: 'bool' as const, labels: LABELS },
        {
          code: 'certificate_note',
          kind: 'text' as const,
          labels: LABELS,
          validation: { maxLength: 5 },
        },
      ],
    };
    const known = facts(
      { id: ID_A, typeCode: 'language' },
      { id: LEVEL, typeCode: 'language_level', rank: 5 },
    );

    it('copies the level rank, so a >= C1 filter is a range test', () => {
      const result = parse(
        field,
        [
          {
            itemId: ID_A,
            levelId: LEVEL,
            has_certificate: true,
            certificate_note: 'TRKI',
          },
        ],
        known,
      );

      expect(result.violations).toEqual([]);
      expect(result.value).toEqual({
        type: 'leveled',
        value: [
          {
            itemId: ID_A,
            levelId: LEVEL,
            levelRank: 5,
            extras: { has_certificate: true, certificate_note: 'TRKI' },
          },
        ],
      });
    });

    it('requires a level on every row', () => {
      expect(
        parse(field, [{ itemId: ID_A }], known).violations[0],
      ).toMatchObject({
        field: 'field.levelId',
      });
    });

    it('refuses a level from the wrong scale, or one with no rank', () => {
      const wrong = facts(
        { id: ID_A, typeCode: 'language' },
        { id: LEVEL, typeCode: 'skill_level', rank: 2 },
      );
      const unranked = facts(
        { id: ID_A, typeCode: 'language' },
        { id: LEVEL, typeCode: 'language_level', rank: null },
      );

      expect(
        parse(field, [{ itemId: ID_A, levelId: LEVEL }], wrong).violations[0],
      ).toMatchObject({ field: 'field.levelId' });
      expect(
        parse(field, [{ itemId: ID_A, levelId: LEVEL }], unranked)
          .violations[0],
      ).toMatchObject({ field: 'field.levelId' });
    });

    it('keeps the last row for a repeated item, which is the corrected level', () => {
      const other = facts(
        { id: ID_A, typeCode: 'language' },
        { id: LEVEL, typeCode: 'language_level', rank: 5 },
        { id: ID_B, typeCode: 'language_level', rank: 2 },
      );
      const result = parse(
        field,
        [
          { itemId: ID_A, levelId: LEVEL },
          { itemId: ID_A, levelId: ID_B },
        ],
        other,
      );

      // Two rows for one item would break the child table's primary key.
      expect(result.value).toMatchObject({ type: 'leveled' });
      expect((result.value as { value: unknown[] }).value).toHaveLength(1);
    });

    it('validates declared extras and ignores undeclared keys', () => {
      const result = parse(
        field,
        [
          {
            itemId: ID_A,
            levelId: LEVEL,
            certificate_note: 'far too long',
            injected: 'ignored',
          },
        ],
        known,
      );

      expect(result.violations[0]).toMatchObject({
        field: 'field.certificate_note',
        rule: 'maxLength',
      });
    });

    it('defaults a missing extra to null rather than dropping the row', () => {
      const result = parse(field, [{ itemId: ID_A, levelId: LEVEL }], known);

      expect(result.value).toEqual({
        type: 'leveled',
        value: [
          {
            itemId: ID_A,
            levelId: LEVEL,
            levelRank: 5,
            extras: { has_certificate: null, certificate_note: null },
          },
        ],
      });
    });
  });
});
