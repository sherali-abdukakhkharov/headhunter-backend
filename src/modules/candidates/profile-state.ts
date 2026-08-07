import type { Database } from '@infra/db/database.module';
import type {
  DictionaryCategory,
  ProfileVisibility,
} from '@infra/db/database.types';
import type { CategoryOrNone } from '@modules/schemas/schema-resolver';
import { fieldsFor } from '@modules/schemas/schema-resolver';
import type {
  FieldSchemaDefinition,
  SchemaField,
} from '@modules/schemas/schema-types';

/**
 * Reading a candidate profile back out.
 *
 * The whole aggregate is loaded and then projected onto field codes, so
 * `GET /candidates/me/profile` returns exactly the shape `PATCH` accepts: a client
 * can read, edit one value, and send it back. The alternative - a bespoke response
 * shape per section - means the client maintains two mappings and they drift.
 */

export interface ProfileRow {
  user_id: string;
  full_name: string | null;
  date_of_birth: string | null;
  gender_id: string | null;
  region_id: string | null;
  district_id: string | null;
  settlement: string | null;
  willing_to_relocate: boolean | null;
  willing_to_travel: boolean | null;
  category: DictionaryCategory | null;
  available_from: string | null;
  salary_from: string | null;
  salary_to: string | null;
  salary_period_id: string | null;
  salary_is_negotiable: boolean;
  visibility: ProfileVisibility;
  completeness_percent: number;
  is_complete: boolean;
  last_meaningful_update_at: Date | null;
  /** Null only on a profile that does not exist yet - see `emptyAggregate`. */
  updated_at: Date | null;
}

export interface ProfileAggregate {
  row: ProfileRow;
  occupations: {
    itemId: string;
    levelId: string | null;
    isPrimary: boolean;
  }[];
  skills: { itemId: string; levelId: string }[];
  languages: {
    itemId: string;
    levelId: string;
    hasCertificate: boolean;
    certificateNote: string | null;
  }[];
  attributes: {
    fieldCode: string;
    itemId: string | null;
    valueBool: boolean | null;
    valueInt: number | null;
    valueDecimal: string | null;
    valueText: string | null;
    valueDate: string | null;
  }[];
  experienceCount: number;
  educationCount: number;
}

const PROFILE_COLUMNS = [
  'user_id',
  'full_name',
  'date_of_birth',
  'gender_id',
  'region_id',
  'district_id',
  'settlement',
  'willing_to_relocate',
  'willing_to_travel',
  'category',
  'available_from',
  'salary_from',
  'salary_to',
  'salary_period_id',
  'salary_is_negotiable',
  'visibility',
  'completeness_percent',
  'is_complete',
  'last_meaningful_update_at',
  'updated_at',
] as const;

/**
 * The profile a candidate has not started yet.
 *
 * Returned instead of a 404 so the profile screen has one code path: every field is
 * present and empty, completeness is 0, and `isStarted` on the response says which
 * case it is. A 404 for "you have not filled this in yet" is an error the client has
 * to special-case, and the state is not exceptional - it is where every candidate
 * begins.
 */
export function emptyAggregate(userId: string): ProfileAggregate {
  return {
    row: {
      user_id: userId,
      full_name: null,
      date_of_birth: null,
      gender_id: null,
      region_id: null,
      district_id: null,
      settlement: null,
      willing_to_relocate: null,
      willing_to_travel: null,
      category: null,
      available_from: null,
      salary_from: null,
      salary_to: null,
      salary_period_id: null,
      salary_is_negotiable: false,
      visibility: 'hidden',
      completeness_percent: 0,
      is_complete: false,
      last_meaningful_update_at: null,
      // Null rather than "now": nothing has been updated, and a fabricated
      // timestamp would be indistinguishable from a real one.
      updated_at: null,
    },
    occupations: [],
    skills: [],
    languages: [],
    attributes: [],
    experienceCount: 0,
    educationCount: 0,
  };
}

/** Loads the whole profile. Safe to call inside a transaction - takes the handle. */
export async function loadAggregate(
  db: Database,
  userId: string,
): Promise<ProfileAggregate | null> {
  const row = await db
    .selectFrom('candidate_profiles')
    .select(PROFILE_COLUMNS)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const [occupations, skills, languages, attributes, experience, education] =
    await Promise.all([
      db
        .selectFrom('candidate_occupations')
        .select(['item_id', 'level_id', 'is_primary'])
        .where('user_id', '=', userId)
        .orderBy('is_primary', 'desc')
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('candidate_skills')
        .select(['item_id', 'level_id'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('candidate_languages')
        .select(['item_id', 'level_id', 'has_certificate', 'certificate_note'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('candidate_attributes')
        .select([
          'field_code',
          'item_id',
          'value_bool',
          'value_int',
          'value_decimal',
          'value_text',
          'value_date',
        ])
        .where('user_id', '=', userId)
        .execute(),
      db
        .selectFrom('candidate_experience')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('candidate_education')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ]);

  return {
    row: row,
    occupations: occupations.map((o) => ({
      itemId: o.item_id,
      levelId: o.level_id,
      isPrimary: o.is_primary,
    })),
    skills: skills.map((s) => ({ itemId: s.item_id, levelId: s.level_id })),
    languages: languages.map((l) => ({
      itemId: l.item_id,
      levelId: l.level_id,
      hasCertificate: l.has_certificate,
      certificateNote: l.certificate_note,
    })),
    attributes: attributes.map((a) => ({
      fieldCode: a.field_code,
      itemId: a.item_id,
      valueBool: a.value_bool,
      valueInt: a.value_int,
      valueDecimal: a.value_decimal,
      valueText: a.value_text,
      valueDate: a.value_date,
    })),
    experienceCount: Number(experience.count),
    educationCount: Number(education.count),
  };
}

/** Every field of the category, projected to the shape `PATCH` accepts. */
export function toFields(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  aggregate: ProfileAggregate,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const field of fieldsFor(definition, category)) {
    fields[field.code] = valueOf(field, aggregate);
  }

  return fields;
}

/**
 * Codes that count as answered, for §5.3's percentage.
 *
 * An empty list and a null are both unanswered; `false` is an answer. That
 * distinction is why the two willingness columns are nullable - a `NOT NULL
 * DEFAULT false` switch could never be missing and would inflate every
 * percentage.
 */
export function filledCodes(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  aggregate: ProfileAggregate,
): Set<string> {
  const filled = new Set<string>();

  for (const field of fieldsFor(definition, category)) {
    if (isAnswered(valueOf(field, aggregate))) {
      filled.add(field.code);
    }
  }

  if (aggregate.experienceCount > 0) {
    filled.add('experience');
  }

  if (aggregate.educationCount > 0) {
    filled.add('education');
  }

  return filled;
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  // money_range: negotiable alone is an answer, and so is a one-sided range.
  if (typeof value === 'object') {
    const money = value as Record<string, unknown>;
    return (
      money.isNegotiable === true ||
      money.from !== null ||
      money.to !== null ||
      money.periodId !== null
    );
  }

  return value !== '';
}

function valueOf(field: SchemaField, aggregate: ProfileAggregate): unknown {
  const { row } = aggregate;

  switch (field.storage.kind) {
    case 'column': {
      const value = row[field.storage.column as keyof ProfileRow];
      return value ?? null;
    }
    case 'money':
      return {
        from: row.salary_from === null ? null : Number(row.salary_from),
        to: row.salary_to === null ? null : Number(row.salary_to),
        periodId: row.salary_period_id,
        currency: field.currency ?? null,
        isNegotiable: row.salary_is_negotiable,
      };
    case 'occupation_primary':
      return aggregate.occupations.find((o) => o.isPrimary)?.itemId ?? null;
    case 'occupation_level':
      return aggregate.occupations.find((o) => o.isPrimary)?.levelId ?? null;
    case 'occupation_additional':
      return aggregate.occupations
        .filter((o) => !o.isPrimary)
        .map((o) => o.itemId);
    case 'skills':
      return aggregate.skills.map((s) => ({
        itemId: s.itemId,
        levelId: s.levelId,
      }));
    case 'languages':
      return aggregate.languages.map((l) => ({
        itemId: l.itemId,
        levelId: l.levelId,
        has_certificate: l.hasCertificate,
        certificate_note: l.certificateNote,
      }));
    case 'attribute':
      return attributeValue(field, aggregate);
  }
}

function attributeValue(
  field: SchemaField,
  aggregate: ProfileAggregate,
): unknown {
  const rows = aggregate.attributes.filter(
    (attribute) => attribute.fieldCode === field.code,
  );

  if (field.kind === 'dictionary_multi') {
    return rows
      .map((attribute) => attribute.itemId)
      .filter((id): id is string => id !== null);
  }

  const single = rows[0];

  if (!single) {
    return null;
  }

  switch (field.kind) {
    case 'bool':
      return single.valueBool;
    case 'int':
      return single.valueInt;
    case 'decimal':
      return single.valueDecimal === null ? null : Number(single.valueDecimal);
    case 'date':
      return single.valueDate;
    case 'dictionary_single':
      return single.itemId;
    default:
      return single.valueText;
  }
}
