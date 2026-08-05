import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';

/**
 * Shape of a field-schema declaration (docs/API_CONTRACTS.md §4).
 *
 * One declaration serves three jobs, which is the point: the client's form, the
 * server's re-validation of a write, and the completeness calculation all read
 * the same object. Three separate lists would be three chances for a field to be
 * required in one and unknown in another - and a `requiredForSearchable` code
 * that resolves to no field is exactly what §4.1 forbids.
 *
 * `storage` never reaches the client. It is here rather than in a mapping table
 * next door so that adding a field is one edit in one place.
 */

/** All four interface variants, as in the dictionary seed. */
export type Labels = Record<LocaleCode, string>;

/** The frozen closed union of API_CONTRACTS.md §4.2. Adding a member is a release. */
export type FieldKind =
  | 'text'
  | 'long_text'
  | 'int'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'date_range'
  | 'url'
  | 'phone'
  | 'money_range'
  | 'dictionary_single'
  | 'dictionary_multi'
  | 'dictionary_leveled';

/**
 * Advisory for the client, enforced by the server (§4.2 rule 3).
 *
 * Only rules some field actually uses are declared; an unused rule would be a
 * validator branch nothing exercises.
 */
export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  /** money_range only: `from <= to` (§4.3). */
  requireFromLteTo?: boolean;
  /**
   * `date` only: reject a date after today. §4.1's example uses the mirror rule
   * (`notBefore: "today"`); this is the direction a birth date needs.
   */
  notAfter?: 'today';
  /**
   * `date` only: the date must be at least this many years ago.
   *
   * Exists so an under-age registration is refused with a field-level message
   * instead of a check-constraint failure mid-write. The column keeps its CHECK as
   * the backstop - this is the layer that can explain itself.
   */
  minAgeYears?: number;
}

/** A per-row extra on a `dictionary_leveled` field. Depth 1, `bool` or `text` (§4.4). */
export interface FieldExtra {
  code: string;
  kind: 'bool' | 'text';
  labels: Labels;
  validation?: FieldValidation;
}

/**
 * Where a field's value lives.
 *
 * - `column` - a column on `candidate_profiles`.
 * - `money` - the four `salary_*` columns, written as one field (§4.3).
 * - `occupation_primary` / `occupation_level` / `occupation_additional` -
 *   `candidate_occupations`. Split into three fields because the primary
 *   occupation decides the profile's category and its level, so "which one is
 *   primary" must be stated rather than inferred from array order.
 * - `skills` / `languages` - their own tables, because level comparisons and
 *   match-all semantics need rows (ARCHITECTURE.md §5).
 * - `attribute` - a `candidate_attributes` row per value. Every §5.2 category
 *   field, plus the core multi-selects that need no column of their own: one
 *   indexed key/value table answers "has this tool" and "accepts this employment
 *   type" with the same join, and neither needs a migration to add.
 */
export type FieldStorage =
  | { kind: 'column'; column: string }
  | { kind: 'money' }
  | { kind: 'occupation_primary' }
  | { kind: 'occupation_level' }
  | { kind: 'occupation_additional' }
  | { kind: 'skills' }
  | { kind: 'languages' }
  | { kind: 'attribute' };

export interface SchemaField {
  /** Stable code. The write body is keyed by it (§4.6), so renaming one is a contract change. */
  code: string;
  kind: FieldKind;
  labels: Labels;
  storage: FieldStorage;
  /**
   * Categories this field appears in. Omitted means all five - the §5.1 core
   * profile. A category field lists its own (§5.2).
   */
  categories?: DictionaryCategory[];
  /**
   * Categories where the field must be filled before the profile can be
   * searchable (BR-02). `'all'` or a list; omitted means never required.
   *
   * This is the *only* source of `requiredForSearchable`, so the response's
   * `required` flag and that list cannot disagree.
   */
  requiredIn?: 'all' | DictionaryCategory[];
  /** Dictionary type for the three `dictionary_*` kinds. */
  dictionaryType?: string;
  /** `attribute` items only: which `item_group` to offer (§3.4). */
  group?: string;
  /** `dictionary_leveled` only: the ordered scale (§4.4). */
  levelDictionaryType?: string;
  extras?: FieldExtra[];
  /**
   * `dictionary_single` only: the field whose selection restricts this one to its
   * children - a district within the chosen region. Additive to §4.1; without it
   * the client would have to hardcode "districts are the children of region",
   * which is the hardcoding the schema exists to remove.
   */
  parentFieldCode?: string;
  /** money_range only (§4.3). */
  currency?: string;
  periodDictionaryType?: string;
  allowNegotiable?: boolean;
  validation?: FieldValidation;
}

export interface SchemaSection {
  code: string;
  /** `core` is backed by columns, `category` by attribute rows. The client does not care (§4.1). */
  source: 'core' | 'category';
  labels: Labels;
  repeating: boolean;
  /** `bespoke` hands the section to a purpose-built widget; `fields` is then empty (§4.1). */
  editor: 'engine' | 'bespoke';
  /** Bespoke sections only: the sub-resource that owns the rows. */
  endpoint?: string;
  fields: SchemaField[];
  /**
   * Bespoke sections only - an engine section is emitted when any of its fields
   * applies to the requested category, which is the same question asked of the
   * fields themselves.
   */
  categories?: DictionaryCategory[];
}

/**
 * A declarative attachment slot (§4.5).
 *
 * Files are deliberately outside the field union: an upload needs progress,
 * cancel, retry and per-viewer authorization, which a dynamic form field cannot
 * carry. The slot is still data, so a new evidence type is a `file_purpose` row
 * plus an entry here rather than a client release.
 */
export interface SchemaAttachment {
  /** `file_purpose` dictionary code. The response carries the resolved id and label. */
  purposeCode: string;
  categories?: DictionaryCategory[];
  required?: boolean;
  /** Extensions, and a subset of what `FilesService` accepts - asserted by a test. */
  accept: string[];
  /** How many may exist at once. Exceeding it supersedes the oldest. */
  maxCount: number;
}

export interface FieldSchemaDefinition {
  target: 'candidate_profile' | 'vacancy';
  /**
   * Bumped by hand when the declaration below changes in a way a client must
   * refetch: a new field, a changed requiredness, an edited label.
   *
   * Declared in code because the schema is code. `pnpm seed` copies it into
   * `schema_versions`, which is what the manifest and the ETag read - so the
   * published version cannot drift from the definition without a seed run, and a
   * forgotten bump shows up as a stale version in one place rather than as a
   * client that never refetches.
   */
  version: number;
  sections: SchemaSection[];
  attachments: SchemaAttachment[];
}
