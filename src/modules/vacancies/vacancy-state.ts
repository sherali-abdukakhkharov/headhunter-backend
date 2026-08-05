import type { Transaction } from 'kysely';

import type { Database } from '@infra/db/database.module';
import type {
  DB,
  DictionaryCategory,
  VacancyStatus,
} from '@infra/db/database.types';
import type { ParsedFields, ParsedValue } from '@modules/schemas/field-values';
import type { CategoryOrNone } from '@modules/schemas/schema-resolver';
import { fieldsFor } from '@modules/schemas/schema-resolver';
import type {
  FieldSchemaDefinition,
  SchemaField,
} from '@modules/schemas/schema-types';

/**
 * Reading and writing one vacancy's fields.
 *
 * The vacancy target's counterpart to `candidates/profile-state.ts` and
 * `profile-writer.ts`, and it works the same way: a value is read back in exactly the
 * shape `PATCH` accepts, and a list field is rewritten wholesale rather than merged,
 * because a body carrying `skills` states the whole skill list - the only reading that
 * lets an employer remove one.
 *
 * Nothing here throws. Every value arrived validated, so the transaction that calls it
 * cannot fail halfway and lose a write it already made.
 */

export interface VacancyRow {
  id: string;
  employer_user_id: string;
  category: DictionaryCategory | null;
  occupation_id: string | null;
  title: string | null;
  description: string | null;
  worker_count: number | null;
  hired_count: number;
  region_id: string | null;
  district_id: string | null;
  address: string | null;
  salary_from: string | null;
  salary_to: string | null;
  salary_period_id: string | null;
  salary_is_negotiable: boolean;
  starts_on: string | null;
  ends_on: string | null;
  deadline_on: string | null;
  age_min: number | null;
  age_max: number | null;
  gender_id: string | null;
  restriction_justification_id: string | null;
  restriction_justification_note: string | null;
  status: VacancyStatus;
  moderation_reason: string | null;
  published_at: Date | null;
  closed_at: Date | null;
  closure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RequirementRow {
  fieldCode: string;
  itemId: string | null;
  levelId: string | null;
  isMandatory: boolean;
  valueBool: boolean | null;
  valueInt: number | null;
  valueDecimal: string | null;
  valueText: string | null;
  valueDate: string | null;
}

export interface VacancyAggregate {
  row: VacancyRow;
  requirements: RequirementRow[];
}

export const VACANCY_COLUMNS = [
  'id',
  'employer_user_id',
  'category',
  'occupation_id',
  'title',
  'description',
  'worker_count',
  'hired_count',
  'region_id',
  'district_id',
  'address',
  'salary_from',
  'salary_to',
  'salary_period_id',
  'salary_is_negotiable',
  'starts_on',
  'ends_on',
  'deadline_on',
  'age_min',
  'age_max',
  'gender_id',
  'restriction_justification_id',
  'restriction_justification_note',
  'status',
  'moderation_reason',
  'published_at',
  'closed_at',
  'closure_reason',
  'created_at',
  'updated_at',
] as const;

export async function loadVacancy(
  db: Database,
  vacancyId: string,
): Promise<VacancyAggregate | null> {
  const row = await db
    .selectFrom('vacancies')
    .select(VACANCY_COLUMNS)
    .where('id', '=', vacancyId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const requirements = await db
    .selectFrom('vacancy_requirements')
    .select([
      'field_code',
      'item_id',
      'level_id',
      'is_mandatory',
      'value_bool',
      'value_int',
      'value_decimal',
      'value_text',
      'value_date',
    ])
    .where('vacancy_id', '=', vacancyId)
    .orderBy('created_at')
    .execute();

  return {
    row: row,
    requirements: requirements.map((requirement) => ({
      fieldCode: requirement.field_code,
      itemId: requirement.item_id,
      levelId: requirement.level_id,
      isMandatory: requirement.is_mandatory,
      valueBool: requirement.value_bool,
      valueInt: requirement.value_int,
      valueDecimal: requirement.value_decimal,
      valueText: requirement.value_text,
      valueDate: requirement.value_date,
    })),
  };
}

/** Every field of the category, in the shape `PATCH` accepts. */
export function toVacancyFields(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  aggregate: VacancyAggregate,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const field of fieldsFor(definition, category)) {
    fields[field.code] = vacancyValueOf(field, aggregate);
  }

  return fields;
}

/** Codes with a value, for the submit-readiness check. */
export function filledVacancyCodes(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  aggregate: VacancyAggregate,
): Set<string> {
  const filled = new Set<string>();

  for (const field of fieldsFor(definition, category)) {
    if (isAnswered(vacancyValueOf(field, aggregate))) {
      filled.add(field.code);
    }
  }

  return filled;
}

export async function applyVacancyFields(
  trx: Transaction<DB>,
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  vacancyId: string,
  values: ParsedFields,
): Promise<void> {
  const byCode = new Map(
    fieldsFor(definition, category).map((field) => [field.code, field]),
  );
  const columns: Record<string, unknown> = {};

  for (const [code, value] of values) {
    const field = byCode.get(code);

    if (!field) {
      continue;
    }

    switch (field.storage.kind) {
      case 'column':
        columns[field.storage.column] = scalar(value);
        break;
      case 'money':
        Object.assign(columns, moneyColumns(value));
        break;
      case 'requirement':
        await writeRequirement(trx, vacancyId, field, value);
        break;
      default:
        // A candidate-only storage kind on a vacancy field is a programming error in
        // the declaration, not a request error - and the schema contract test catches
        // it before a request ever gets here.
        throw new Error(
          `Field ${field.code} uses storage ${field.storage.kind}, which the vacancy target does not support`,
        );
    }
  }

  if (Object.keys(columns).length > 0) {
    await trx
      .updateTable('vacancies')
      .set(columns)
      .where('id', '=', vacancyId)
      .execute();
  }
}

/**
 * One `vacancy_requirements` row per value.
 *
 * A leveled requirement carries its level's rank and §6.3's mandatory flag; the flag
 * defaults to **true**, because a requirement stated without qualification is one the
 * employer means.
 */
async function writeRequirement(
  trx: Transaction<DB>,
  vacancyId: string,
  field: SchemaField,
  value: ParsedValue,
): Promise<void> {
  await trx
    .deleteFrom('vacancy_requirements')
    .where('vacancy_id', '=', vacancyId)
    .where('field_code', '=', field.code)
    .execute();

  if (value.type === 'leveled') {
    const rows = value.value.map((row) => ({
      vacancy_id: vacancyId,
      field_code: field.code,
      item_id: row.itemId,
      level_id: row.levelId,
      level_rank: row.levelRank,
      is_mandatory: row.extras.is_mandatory !== false,
    }));

    if (rows.length > 0) {
      await trx.insertInto('vacancy_requirements').values(rows).execute();
    }

    return;
  }

  if (value.type === 'ids') {
    const rows = value.value.map((id) => ({
      vacancy_id: vacancyId,
      field_code: field.code,
      item_id: id,
    }));

    if (rows.length > 0) {
      await trx.insertInto('vacancy_requirements').values(rows).execute();
    }

    return;
  }

  const raw = scalar(value);

  if (raw === null) {
    return;
  }

  await trx
    .insertInto('vacancy_requirements')
    .values({
      vacancy_id: vacancyId,
      field_code: field.code,
      ...requirementColumn(field, raw),
    })
    .execute();
}

function requirementColumn(
  field: SchemaField,
  raw: string | number | boolean,
): Record<string, unknown> {
  switch (field.kind) {
    case 'bool':
      return { value_bool: raw };
    case 'int':
      return { value_int: raw };
    case 'decimal':
      return { value_decimal: raw };
    case 'date':
      return { value_date: raw };
    case 'dictionary_single':
      return { item_id: raw };
    default:
      return { value_text: raw };
  }
}

function vacancyValueOf(
  field: SchemaField,
  aggregate: VacancyAggregate,
): unknown {
  const { row } = aggregate;

  if (field.storage.kind === 'column') {
    return row[field.storage.column as keyof VacancyRow] ?? null;
  }

  if (field.storage.kind === 'money') {
    return {
      from: row.salary_from === null ? null : Number(row.salary_from),
      to: row.salary_to === null ? null : Number(row.salary_to),
      periodId: row.salary_period_id,
      currency: field.currency ?? null,
      isNegotiable: row.salary_is_negotiable,
    };
  }

  const rows = aggregate.requirements.filter(
    (requirement) => requirement.fieldCode === field.code,
  );

  if (field.kind === 'dictionary_leveled') {
    return rows.map((requirement) => ({
      itemId: requirement.itemId,
      levelId: requirement.levelId,
      is_mandatory: requirement.isMandatory,
    }));
  }

  if (field.kind === 'dictionary_multi') {
    return rows
      .map((requirement) => requirement.itemId)
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

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

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

function scalar(value: ParsedValue): string | number | boolean | null {
  return value.type === 'scalar' ? value.value : null;
}

function moneyColumns(value: ParsedValue): Record<string, unknown> {
  if (value.type !== 'money') {
    return {};
  }

  return {
    salary_from: value.value.from,
    salary_to: value.value.to,
    salary_period_id: value.value.periodId,
    salary_is_negotiable: value.value.isNegotiable,
  };
}
