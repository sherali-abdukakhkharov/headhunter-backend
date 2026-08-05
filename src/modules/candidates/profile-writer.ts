import type { Transaction } from 'kysely';

import type { DB } from '@infra/db/database.types';
import type { ParsedFields, ParsedValue } from '@modules/schemas/field-values';
import type {
  FieldSchemaDefinition,
  SchemaField,
} from '@modules/schemas/schema-types';
import { fieldsFor } from '@modules/schemas/schema-resolver';

import type { CategoryOrNone } from '@modules/schemas/schema-resolver';

/**
 * Applies validated field values to the profile's tables.
 *
 * Two decisions shape everything here:
 *
 * - **Sets are rewritten, not merged.** Occupations, skills, languages and every
 *   multi-select attribute are deleted for that field and re-inserted from the
 *   submitted value. `PATCH` is partial at the level of *fields*, not of list
 *   members: a body carrying `skills` states the whole skill list, which is the only
 *   reading that lets a candidate remove one. Incremental merging would also have to
 *   dance around `candidate_occupations`' one-primary index.
 * - **Nothing here throws.** Every value arrived validated, so the transaction that
 *   calls this cannot fail halfway and lose a write it already made - the M1 trap
 *   recorded in MEMORY.md. Anything unexpected is a programming error, not a request
 *   error, and would surface as a rolled-back 500 rather than a half-applied save.
 */
export async function applyFields(
  trx: Transaction<DB>,
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  userId: string,
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
      case 'occupation_primary':
      case 'occupation_level':
      case 'occupation_additional':
        // Handled together below: the three fields are one row set, and the
        // primary row carries the level.
        break;
      case 'skills':
        await writeSkills(trx, userId, value);
        break;
      case 'languages':
        await writeLanguages(trx, userId, value);
        break;
      case 'attribute':
        await writeAttribute(trx, userId, field, value);
        break;
    }
  }

  if (Object.keys(columns).length > 0) {
    await trx
      .updateTable('candidate_profiles')
      .set(columns)
      .where('user_id', '=', userId)
      .execute();
  }

  await writeOccupations(trx, userId, values);
}

/**
 * Rewrites the occupation set from whichever of the three fields were submitted.
 *
 * The current rows supply what the request left out, so patching only
 * `additional_occupation_ids` keeps the primary occupation and its level. The whole
 * set is then replaced in one delete/insert, which is what keeps the one-primary
 * index satisfied at every point rather than only at the end.
 */
async function writeOccupations(
  trx: Transaction<DB>,
  userId: string,
  values: ParsedFields,
): Promise<void> {
  const primaryValue = values.get('primary_occupation_id');
  const levelValue = values.get('occupation_level_id');
  const additionalValue = values.get('additional_occupation_ids');

  if (!primaryValue && !levelValue && !additionalValue) {
    return;
  }

  const current = await trx
    .selectFrom('candidate_occupations')
    .select(['item_id', 'level_id', 'is_primary'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();

  const currentPrimary = current.find((row) => row.is_primary);

  const primaryId = primaryValue
    ? (scalar(primaryValue) as string | null)
    : (currentPrimary?.item_id ?? null);

  const levelId = levelValue
    ? (scalar(levelValue) as string | null)
    : (currentPrimary?.level_id ?? null);

  const additional = additionalValue
    ? ids(additionalValue)
    : current.filter((row) => !row.is_primary).map((row) => row.item_id);

  await trx
    .deleteFrom('candidate_occupations')
    .where('user_id', '=', userId)
    .execute();

  const rows = [
    ...(primaryId
      ? [
          {
            user_id: userId,
            item_id: primaryId,
            level_id: levelId,
            is_primary: true,
          },
        ]
      : []),
    // An id that is also the primary would violate the (user, item) key, and the
    // primary row is the one to keep.
    ...additional
      .filter((id) => id !== primaryId)
      .map((id) => ({
        user_id: userId,
        item_id: id,
        level_id: null,
        is_primary: false,
      })),
  ];

  if (rows.length > 0) {
    await trx.insertInto('candidate_occupations').values(rows).execute();
  }
}

async function writeSkills(
  trx: Transaction<DB>,
  userId: string,
  value: ParsedValue,
): Promise<void> {
  await trx
    .deleteFrom('candidate_skills')
    .where('user_id', '=', userId)
    .execute();

  const rows = leveled(value).map((row) => ({
    user_id: userId,
    item_id: row.itemId,
    level_id: row.levelId,
    level_rank: row.levelRank,
  }));

  if (rows.length > 0) {
    await trx.insertInto('candidate_skills').values(rows).execute();
  }
}

async function writeLanguages(
  trx: Transaction<DB>,
  userId: string,
  value: ParsedValue,
): Promise<void> {
  await trx
    .deleteFrom('candidate_languages')
    .where('user_id', '=', userId)
    .execute();

  const rows = leveled(value).map((row) => ({
    user_id: userId,
    item_id: row.itemId,
    level_id: row.levelId,
    level_rank: row.levelRank,
    has_certificate: row.extras.has_certificate === true,
    certificate_note:
      typeof row.extras.certificate_note === 'string'
        ? row.extras.certificate_note
        : null,
  }));

  if (rows.length > 0) {
    await trx.insertInto('candidate_languages').values(rows).execute();
  }
}

/**
 * One `candidate_attributes` row per value: a multi-select becomes one row per
 * selected id, a scalar one row in the column matching its kind.
 */
async function writeAttribute(
  trx: Transaction<DB>,
  userId: string,
  field: SchemaField,
  value: ParsedValue,
): Promise<void> {
  await trx
    .deleteFrom('candidate_attributes')
    .where('user_id', '=', userId)
    .where('field_code', '=', field.code)
    .execute();

  if (value.type === 'ids') {
    const rows = value.value.map((id) => ({
      user_id: userId,
      field_code: field.code,
      item_id: id,
    }));

    if (rows.length > 0) {
      await trx.insertInto('candidate_attributes').values(rows).execute();
    }

    return;
  }

  const raw = scalar(value);

  // Cleared, so the delete above is the whole write. The table's CHECK requires
  // exactly one value column, which an all-null row could not satisfy anyway.
  if (raw === null) {
    return;
  }

  await trx
    .insertInto('candidate_attributes')
    .values({
      user_id: userId,
      field_code: field.code,
      ...attributeColumn(field, raw),
    })
    .execute();
}

function attributeColumn(
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

function scalar(value: ParsedValue): string | number | boolean | null {
  return value.type === 'scalar' ? value.value : null;
}

function ids(value: ParsedValue): string[] {
  return value.type === 'ids' ? value.value : [];
}

function leveled(value: ParsedValue) {
  return value.type === 'leveled' ? value.value : [];
}
