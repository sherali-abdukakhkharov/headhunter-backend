import type { FieldViolation } from '@infra/api/exceptions/validation-failed.exception';

import type { DictionaryItemFacts } from '@modules/dictionaries/dictionaries.service';

import type { ParsedLeveledRow, ParsedValue } from './field-values';
import type { FieldExtra, FieldKind, SchemaField } from './schema-types';

/**
 * Validation of one field's raw value against its declaration.
 *
 * Pure: everything the rules need about dictionary ids is passed in as facts, so
 * the whole thing is unit-testable without a database and the service above it is
 * only an orchestrator. §4.2 rule 3 - "the server re-validates every write against
 * the same schema" - is what this file is; client-side validation is UX, and a
 * stale client schema must produce a clean 422 rather than a corrupt row.
 *
 * The output is the value in storage shape, so nothing downstream re-parses input.
 */

/** Values already stored, by field code. Resolves a `parentFieldCode` the request omitted. */
export type StoredScalars = Map<string, string | null>;

export interface ValidationContext {
  stored: StoredScalars;
  /**
   * Today in the platform zone, `'YYYY-MM-DD'`.
   *
   * Injected rather than read from the clock here: "today" in Tashkent is the
   * previous UTC day for five hours out of every twenty-four, so the zone has to
   * come from configuration - and a date rule that cannot be given a fixed today
   * cannot be tested.
   */
  today: string;
}

export interface FieldParseResult {
  value?: ParsedValue;
  violations: FieldViolation[];
}

/** Kinds the candidate-profile target uses. `date_range` and `phone` arrive with M5. */
const SUPPORTED: FieldKind[] = [
  'text',
  'long_text',
  'int',
  'decimal',
  'bool',
  'date',
  'url',
  'money_range',
  'dictionary_single',
  'dictionary_multi',
  'dictionary_leveled',
];

export function isSupportedKind(kind: FieldKind): boolean {
  return SUPPORTED.includes(kind);
}

export function parseField(
  field: SchemaField,
  raw: unknown,
  facts: Map<string, DictionaryItemFacts>,
  context: ValidationContext,
): FieldParseResult {
  // Absent and null both mean "clear it". An empty string does too: a mobile form
  // that clears a text input sends `""`, and storing that would make a blank value
  // count as filled toward completeness.
  if (raw === null || raw === undefined || raw === '') {
    return { value: emptyFor(field), violations: [] };
  }

  switch (field.kind) {
    case 'text':
    case 'long_text':
      return parseText(field, raw);
    case 'url':
      return parseUrl(field, raw);
    case 'int':
      return parseNumber(field, raw, true);
    case 'decimal':
      return parseNumber(field, raw, false);
    case 'bool':
      return typeof raw === 'boolean'
        ? { value: { type: 'scalar', value: raw }, violations: [] }
        : {
            violations: [
              violation(field.code, 'isBoolean', 'validation.must_be_boolean'),
            ],
          };
    case 'date':
      return parseDate(field, raw, context.today);
    case 'money_range':
      return parseMoney(field, raw, facts);
    case 'dictionary_single':
      return parseSingle(field, raw, facts, context.stored);
    case 'dictionary_multi':
      return parseMulti(field, raw, facts);
    case 'dictionary_leveled':
      return parseLeveled(field, raw, facts);
    default:
      // Unreachable through a route: a field whose kind this target does not
      // support is caught by `isSupportedKind` in the schema contract test, which
      // fails the build rather than a request.
      throw new Error(
        `Field ${field.code} has kind ${field.kind}, which this validator does not handle`,
      );
  }
}

/** Every dictionary id mentioned by a raw value, for the single lookup query. */
export function idsIn(field: SchemaField, raw: unknown): string[] {
  if (field.kind === 'dictionary_single') {
    return typeof raw === 'string' ? [raw] : [];
  }

  if (field.kind === 'dictionary_multi') {
    return Array.isArray(raw) ? raw.filter(isUuid) : [];
  }

  if (field.kind === 'dictionary_leveled') {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.flatMap((row) =>
      isRecord(row)
        ? [row.itemId, row.levelId].filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
  }

  if (field.kind === 'money_range' && isRecord(raw)) {
    return typeof raw.periodId === 'string' ? [raw.periodId] : [];
  }

  return [];
}

// --- per-kind rules --------------------------------------------------------

function parseText(field: SchemaField, raw: unknown): FieldParseResult {
  if (typeof raw !== 'string') {
    return {
      violations: [
        violation(field.code, 'isString', 'validation.must_be_text'),
      ],
    };
  }

  const value = raw.trim();

  if (value === '') {
    return { value: { type: 'scalar', value: null }, violations: [] };
  }

  const { minLength, maxLength } = field.validation ?? {};

  if (minLength !== undefined && value.length < minLength) {
    return {
      violations: [
        violation(field.code, 'minLength', 'validation.too_short', {
          min: minLength,
        }),
      ],
    };
  }

  if (maxLength !== undefined && value.length > maxLength) {
    return {
      violations: [
        violation(field.code, 'maxLength', 'validation.too_long', {
          max: maxLength,
        }),
      ],
    };
  }

  return { value: { type: 'scalar', value }, violations: [] };
}

function parseUrl(field: SchemaField, raw: unknown): FieldParseResult {
  const text = parseText(field, raw);

  if (text.violations.length > 0 || text.value?.type !== 'scalar') {
    return text;
  }

  const value = text.value.value;

  if (typeof value !== 'string') {
    return text;
  }

  // `http`/`https` only: a `javascript:` or `data:` link rendered as a tappable
  // portfolio URL in the client is the reason this is checked server-side.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      violations: [violation(field.code, 'isUrl', 'validation.must_be_url')],
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      violations: [violation(field.code, 'isUrl', 'validation.must_be_url')],
    };
  }

  return text;
}

function parseNumber(
  field: SchemaField,
  raw: unknown,
  integer: boolean,
): FieldParseResult {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return {
      violations: [
        violation(
          field.code,
          integer ? 'isInt' : 'isNumber',
          integer ? 'validation.must_be_integer' : 'validation.must_be_number',
        ),
      ],
    };
  }

  if (integer && !Number.isInteger(raw)) {
    return {
      violations: [
        violation(field.code, 'isInt', 'validation.must_be_integer'),
      ],
    };
  }

  const { min, max } = field.validation ?? {};

  if (min !== undefined && raw < min) {
    return {
      violations: [
        violation(field.code, 'min', 'validation.too_small', { min }),
      ],
    };
  }

  if (max !== undefined && raw > max) {
    return {
      violations: [violation(field.code, 'max', 'validation.too_big', { max })],
    };
  }

  return { value: { type: 'scalar', value: raw }, violations: [] };
}

/**
 * A calendar date, as `'YYYY-MM-DD'` and nothing else.
 *
 * Kept a string end to end (see `infra/db/pg-types.ts`): a date has no instant, so
 * parsing it into one is what shifts a birthday by a day.
 */
function parseDate(
  field: SchemaField,
  raw: unknown,
  today: string,
): FieldParseResult {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return {
      violations: [violation(field.code, 'isDate', 'validation.must_be_date')],
    };
  }

  // Rejects 2026-02-31: `Date.UTC` rolls it over, so a round trip that changes the
  // components proves the date does not exist.
  const [year, month, day] = raw.split('-').map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));

  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return {
      violations: [violation(field.code, 'isDate', 'validation.must_be_date')],
    };
  }

  const { notAfter, minAgeYears } = field.validation ?? {};

  if (notAfter === 'today' && raw > today) {
    return {
      violations: [
        violation(field.code, 'notAfter', 'validation.date_in_future'),
      ],
    };
  }

  if (minAgeYears !== undefined && raw > yearsBefore(today, minAgeYears)) {
    return {
      violations: [
        violation(field.code, 'minAgeYears', 'validation.min_age', {
          min: minAgeYears,
        }),
      ],
    };
  }

  return { value: { type: 'scalar', value: raw }, violations: [] };
}

function parseMoney(
  field: SchemaField,
  raw: unknown,
  facts: Map<string, DictionaryItemFacts>,
): FieldParseResult {
  if (!isRecord(raw)) {
    return {
      violations: [
        violation(field.code, 'isObject', 'validation.not_allowed_value'),
      ],
    };
  }

  const violations: FieldViolation[] = [];
  const isNegotiable = raw.isNegotiable === true;
  const from = numberOrNull(raw.from);
  const to = numberOrNull(raw.to);

  if (from === false || to === false) {
    violations.push(
      violation(field.code, 'isNumber', 'validation.must_be_number'),
    );
  }

  const lower = from === false ? null : from;
  const upper = to === false ? null : to;
  const { min, max, requireFromLteTo } = field.validation ?? {};

  for (const [side, amount] of [
    ['from', lower],
    ['to', upper],
  ] as const) {
    if (amount === null) {
      continue;
    }

    if (min !== undefined && amount < min) {
      violations.push(
        violation(`${field.code}.${side}`, 'min', 'validation.too_small', {
          min,
        }),
      );
    }

    if (max !== undefined && amount > max) {
      violations.push(
        violation(`${field.code}.${side}`, 'max', 'validation.too_big', {
          max,
        }),
      );
    }
  }

  if (requireFromLteTo && lower !== null && upper !== null && lower > upper) {
    violations.push(
      violation(
        field.code,
        'requireFromLteTo',
        'validation.salary_range_order',
      ),
    );
  }

  // §4.3: rejected rather than normalized. "Negotiable, 5-8M" is a contradiction,
  // and silently dropping one half would store something the candidate did not say.
  if (isNegotiable && (lower !== null || upper !== null)) {
    violations.push(
      violation(
        field.code,
        'allowNegotiable',
        'validation.salary_negotiable_excludes_range',
      ),
    );
  }

  let periodId: string | null = null;

  if (typeof raw.periodId === 'string') {
    const period = facts.get(raw.periodId);

    if (!usable(period, field.periodDictionaryType)) {
      violations.push(
        violation(
          `${field.code}.periodId`,
          'dictionaryItem',
          'validation.dictionary_item_invalid',
        ),
      );
    } else {
      periodId = raw.periodId;
    }
  }

  if (violations.length > 0) {
    return { violations };
  }

  return {
    value: {
      type: 'money',
      value: { from: lower, to: upper, periodId, isNegotiable },
    },
    violations: [],
  };
}

function parseSingle(
  field: SchemaField,
  raw: unknown,
  facts: Map<string, DictionaryItemFacts>,
  stored: StoredScalars,
): FieldParseResult {
  if (typeof raw !== 'string' || !isUuid(raw)) {
    return {
      violations: [violation(field.code, 'isUuid', 'validation.must_be_id')],
    };
  }

  const item = facts.get(raw);

  if (!usable(item, field.dictionaryType, field.group)) {
    return {
      violations: [
        violation(
          field.code,
          'dictionaryItem',
          'validation.dictionary_item_invalid',
        ),
      ],
    };
  }

  // A district must sit under the region the profile actually has - taken from
  // this request when it carries one, otherwise from what is stored. Without the
  // second half, setting a district in a later request than the region would skip
  // the check entirely.
  if (field.parentFieldCode) {
    const parentId = stored.get(field.parentFieldCode) ?? null;

    if (parentId !== null && item?.parentId !== parentId) {
      return {
        violations: [
          violation(
            field.code,
            'parentField',
            'validation.district_not_in_region',
          ),
        ],
      };
    }
  }

  return { value: { type: 'scalar', value: raw }, violations: [] };
}

function parseMulti(
  field: SchemaField,
  raw: unknown,
  facts: Map<string, DictionaryItemFacts>,
): FieldParseResult {
  if (!Array.isArray(raw)) {
    return {
      violations: [violation(field.code, 'isArray', 'validation.must_be_list')],
    };
  }

  const violations: FieldViolation[] = [];
  // Deduplicated rather than rejected: the same id twice is a client-side
  // double-tap, and the stored set is identical either way.
  const ids = [...new Set(raw)];

  for (const id of ids) {
    if (typeof id !== 'string' || !isUuid(id)) {
      violations.push(violation(field.code, 'isUuid', 'validation.must_be_id'));
      continue;
    }

    if (!usable(facts.get(id), field.dictionaryType, field.group)) {
      violations.push(
        violation(
          field.code,
          'dictionaryItem',
          'validation.dictionary_item_invalid',
        ),
      );
    }
  }

  const { maxItems } = field.validation ?? {};

  if (maxItems !== undefined && ids.length > maxItems) {
    violations.push(
      violation(field.code, 'maxItems', 'validation.too_many_items', {
        max: maxItems,
      }),
    );
  }

  if (violations.length > 0) {
    return { violations };
  }

  return { value: { type: 'ids', value: ids as string[] }, violations: [] };
}

function parseLeveled(
  field: SchemaField,
  raw: unknown,
  facts: Map<string, DictionaryItemFacts>,
): FieldParseResult {
  if (!Array.isArray(raw)) {
    return {
      violations: [violation(field.code, 'isArray', 'validation.must_be_list')],
    };
  }

  const violations: FieldViolation[] = [];
  const rows: ParsedLeveledRow[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!isRecord(entry)) {
      violations.push(
        violation(field.code, 'isObject', 'validation.not_allowed_value'),
      );
      continue;
    }

    const itemId = entry.itemId;
    const levelId = entry.levelId;

    if (typeof itemId !== 'string' || !isUuid(itemId)) {
      violations.push(
        violation(`${field.code}.itemId`, 'isUuid', 'validation.must_be_id'),
      );
      continue;
    }

    // The same item twice would violate the child table's primary key, and the
    // second entry is what the candidate means: a corrected level.
    if (seen.has(itemId)) {
      continue;
    }

    if (!usable(facts.get(itemId), field.dictionaryType, field.group)) {
      violations.push(
        violation(
          `${field.code}.itemId`,
          'dictionaryItem',
          'validation.dictionary_item_invalid',
        ),
      );
      continue;
    }

    const level = typeof levelId === 'string' ? facts.get(levelId) : undefined;

    // A level is mandatory on every leveled row: §4.4's shape carries one, §5.1
    // asks for a self-declared proficiency, and §7.4's "Russian at C1" cannot be
    // answered by a row without a level.
    if (
      !level ||
      !usable(level, field.levelDictionaryType) ||
      level.rank === null
    ) {
      violations.push(
        violation(
          `${field.code}.levelId`,
          'dictionaryItem',
          'validation.dictionary_item_invalid',
        ),
      );
      continue;
    }

    const extras = parseExtras(field, entry, violations);
    seen.add(itemId);
    rows.push({ itemId, levelId: level.id, levelRank: level.rank, extras });
  }

  const { maxItems } = field.validation ?? {};

  if (maxItems !== undefined && rows.length > maxItems) {
    violations.push(
      violation(field.code, 'maxItems', 'validation.too_many_items', {
        max: maxItems,
      }),
    );
  }

  if (violations.length > 0) {
    return { violations };
  }

  return { value: { type: 'leveled', value: rows }, violations: [] };
}

/** Declared per-row extras only (§4.4): `bool` or `text`, depth 1, nothing else. */
function parseExtras(
  field: SchemaField,
  entry: Record<string, unknown>,
  violations: FieldViolation[],
): Record<string, string | boolean | null> {
  const extras: Record<string, string | boolean | null> = {};

  for (const extra of field.extras ?? []) {
    const raw = entry[extra.code];

    if (raw === undefined || raw === null || raw === '') {
      extras[extra.code] = null;
      continue;
    }

    const path = `${field.code}.${extra.code}`;

    if (extra.kind === 'bool') {
      if (typeof raw !== 'boolean') {
        violations.push(
          violation(path, 'isBoolean', 'validation.must_be_boolean'),
        );
        continue;
      }

      extras[extra.code] = raw;
      continue;
    }

    if (typeof raw !== 'string') {
      violations.push(violation(path, 'isString', 'validation.must_be_text'));
      continue;
    }

    const text = raw.trim();
    const max = extra.validation?.maxLength;

    if (max !== undefined && text.length > max) {
      violations.push(
        violation(path, 'maxLength', 'validation.too_long', { max }),
      );
      continue;
    }

    extras[extra.code] = text === '' ? null : text;
  }

  return extras;
}

// --- helpers ---------------------------------------------------------------

/** What "cleared" looks like for each kind, so a write can actually remove a value. */
function emptyFor(field: SchemaField): ParsedValue {
  switch (field.kind) {
    case 'money_range':
      return {
        type: 'money',
        value: { from: null, to: null, periodId: null, isNegotiable: false },
      };
    case 'dictionary_multi':
      return { type: 'ids', value: [] };
    case 'dictionary_leveled':
      return { type: 'leveled', value: [] };
    default:
      return { type: 'scalar', value: null };
  }
}

/**
 * May this item be stored in this field?
 *
 * Inactive and merged items are refused on a *write* even though they still
 * resolve on a read: keeping a historical reference readable is the point of not
 * deleting them, and that is a different question from letting a new profile
 * select one (§3.2, §10.3).
 */
function usable(
  item: DictionaryItemFacts | undefined,
  expectedType?: string,
  expectedGroup?: string,
): boolean {
  if (!item || !item.isActive || item.mergedIntoId !== null) {
    return false;
  }

  if (expectedType !== undefined && item.typeCode !== expectedType) {
    return false;
  }

  return expectedGroup === undefined || item.group === expectedGroup;
}

function violation(
  field: string,
  rule: string,
  messageKey: FieldViolation['messageKey'],
  params?: FieldViolation['params'],
): FieldViolation {
  return { field, rule, messageKey, ...(params ? { params } : {}) };
}

/** `false` marks "present but not a number", which is a violation rather than absent. */
function numberOrNull(raw: unknown): number | null | false {
  if (raw === null || raw === undefined) {
    return null;
  }

  return typeof raw === 'number' && Number.isFinite(raw) ? raw : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The same calendar day `years` earlier.
 *
 * Date strings are compared lexicographically throughout, which is the reason the
 * `'YYYY-MM-DD'` format is fixed: ISO dates sort as text exactly as they sort as
 * dates, so no parsing and no zone enters a comparison. `Date.UTC` is only used to
 * do the arithmetic, on components that came from a zone-correct today.
 */
function yearsBefore(day: string, years: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year - years, month - 1, date))
    .toISOString()
    .slice(0, 10);
}

export type { FieldExtra };
