import type { DictionaryCategory } from '@infra/db/database.types';

import type {
  FieldSchemaDefinition,
  SchemaAttachment,
  SchemaField,
  SchemaSection,
} from './schema-types';

/**
 * Reduces a field-schema declaration to one category.
 *
 * Pure, and the only place the category rules are applied. The endpoint, the
 * write validator and the completeness calculation all call these functions, so
 * "which fields exist for a seasonal candidate" has exactly one answer.
 */

/**
 * `null` is a real state, not a missing argument: a profile has no category until
 * a primary occupation is chosen, and the honest answer then is "only the fields
 * common to all five categories exist". Treating it as some default category would
 * accept, say, a professional-only field on a profile that may turn out seasonal.
 */
export type CategoryOrNone = DictionaryCategory | null;

/** Does this field appear at all for `category`? Omitted `categories` means all five. */
export function appliesTo(
  field: SchemaField,
  category: CategoryOrNone,
): boolean {
  if (field.categories === undefined) {
    return true;
  }

  return category !== null && field.categories.includes(category);
}

/** Must it be filled before the profile may be searchable (BR-02)? */
export function isRequiredIn(
  field: SchemaField,
  category: CategoryOrNone,
): boolean {
  if (field.requiredIn === undefined) {
    return false;
  }

  if (field.requiredIn === 'all') {
    return true;
  }

  return category !== null && field.requiredIn.includes(category);
}

/**
 * Sections for one category, each carrying only its applicable fields.
 *
 * An engine section is dropped when none of its fields applies - an empty
 * accordion is worse than an absent one. A bespoke section has no fields to
 * filter, so it is kept when its own `categories` allow it.
 */
export function sectionsFor(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
): SchemaSection[] {
  const sections: SchemaSection[] = [];

  for (const section of definition.sections) {
    if (section.editor === 'bespoke') {
      if (
        section.categories === undefined ||
        (category !== null && section.categories.includes(category))
      ) {
        sections.push({ ...section, fields: [] });
      }
      continue;
    }

    const fields = section.fields.filter((field) => appliesTo(field, category));

    if (fields.length > 0) {
      sections.push({ ...section, fields });
    }
  }

  return sections;
}

/** Every engine field of one category, flattened - the write path's routing table. */
export function fieldsFor(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
): SchemaField[] {
  return sectionsFor(definition, category).flatMap((section) => section.fields);
}

/** One field by code, or undefined - which the caller reports as an unknown field. */
export function fieldByCode(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
  code: string,
): SchemaField | undefined {
  return fieldsFor(definition, category).find((field) => field.code === code);
}

/**
 * The BR-02 gate's field codes, derived from the same `requiredIn` declarations
 * the response's `required` flags come from - so §4.1's rule that every code here
 * resolves to a rendered field holds by construction rather than by review.
 */
export function requiredForSearchable(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
): string[] {
  return fieldsFor(definition, category)
    .filter((field) => isRequiredIn(field, category))
    .map((field) => field.code);
}

/** Attachment slots for one category (§4.5). */
export function attachmentsFor(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
): SchemaAttachment[] {
  return definition.attachments.filter(
    (attachment) =>
      attachment.categories === undefined ||
      (category !== null && attachment.categories.includes(category)),
  );
}

/**
 * What §5.3's percentage is measured over: every engine field of the category,
 * plus each bespoke section as a single entry.
 *
 * Including experience and education matters because they are most of what an
 * employer reads. They can never be *required* - a bespoke section has no field
 * for `requiredForSearchable` to name - so an empty history lowers the percentage
 * and prompts the candidate without locking the profile out of search.
 */
export interface CompletenessEntry {
  code: string;
  /** Section the client should open to fill it - §5.3's "direct edit link". */
  section: string;
  required: boolean;
}

export function completenessEntriesFor(
  definition: FieldSchemaDefinition,
  category: CategoryOrNone,
): CompletenessEntry[] {
  const entries: CompletenessEntry[] = [];

  for (const section of sectionsFor(definition, category)) {
    if (section.editor === 'bespoke') {
      entries.push({
        code: section.code,
        section: section.code,
        required: false,
      });
      continue;
    }

    for (const field of section.fields) {
      entries.push({
        code: field.code,
        section: section.code,
        required: isRequiredIn(field, category),
      });
    }
  }

  return entries;
}
