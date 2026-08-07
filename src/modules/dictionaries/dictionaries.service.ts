import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DictionaryCategory,
  LocaleCode,
  SchemaTarget,
} from '@infra/db/database.types';
import { localeFallbackChain } from '@infra/locale/locale';

/** A dictionary item as the client sees it (docs/API_CONTRACTS.md §3.4). */
export interface DictionaryItem {
  id: string;
  code: string;
  label: string;
  category: DictionaryCategory | null;
  group: string | null;
  parentId: string | null;
  sortOrder: number;
  rank: number | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

export interface RemovedItem {
  id: string;
  reason: 'inactive' | 'merged';
  mergedIntoId: string | null;
}

export interface DictionaryDelta {
  type: string;
  locale: LocaleCode;
  version: number;
  since: number | null;
  isFull: boolean;
  items: DictionaryItem[];
  removed: RemovedItem[];
}

export interface TypeVersion {
  type: string;
  version: number;
  count: number;
}

export interface SchemaVersion {
  target: SchemaTarget;
  category: DictionaryCategory;
  version: number;
}

export interface DictionaryManifest {
  version: number;
  types: TypeVersion[];
  schemas: SchemaVersion[];
}

/** What a write path needs to decide whether an id may be stored in a field. */
export interface DictionaryItemFacts {
  id: string;
  typeCode: string;
  group: string | null;
  category: DictionaryCategory | null;
  parentId: string | null;
  rank: number | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

/** One row of the resolved-label query, in database naming. */
interface ResolvedRow {
  id: string;
  code: string;
  label: string | null;
  label_locale: LocaleCode | null;
  category: DictionaryCategory | null;
  item_group: string | null;
  parent_id: string | null;
  sort_order: number;
  rank: number | null;
  is_active: boolean;
  merged_into_id: string | null;
  effective_revision: number;
}

@Injectable()
export class DictionariesService {
  private readonly logger = new Logger(DictionariesService.name);

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async listTypes(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('dictionary_types')
      .select('code')
      .orderBy('code')
      .execute();

    return rows.map((row) => row.code);
  }

  /**
   * Per-type versions and the ten field-schema versions in one response
   * (API_CONTRACTS.md §3.3), so a cold client revalidates everything at once
   * instead of issuing a conditional GET per type and guessing about schemas.
   */
  async manifest(): Promise<DictionaryManifest> {
    const types = await this.typeVersions();

    const schemas = await this.db
      .selectFrom('schema_versions')
      .select(['target', 'category', 'version'])
      .orderBy('target')
      .orderBy('category')
      .execute();

    return {
      // The global version is the newest revision anywhere in the dictionaries.
      // Derived from the type versions rather than the sequence's `last_value`,
      // which reports 1 on a never-used sequence and would look like a real
      // revision.
      version: types.reduce((max, t) => Math.max(max, t.version), 0),
      types,
      schemas,
    };
  }

  /**
   * Version and active-item count per type.
   *
   * A type's version is the highest revision across its items **and** their
   * translations: editing only a Russian label must still invalidate the type,
   * or clients in that locale never see the correction.
   */
  async typeVersions(): Promise<TypeVersion[]> {
    const result = await sql<{
      type: string;
      version: number;
      count: number;
    }>`
      WITH item_revision AS (
        SELECT
          type_code,
          MAX(revision) AS revision,
          count(*) FILTER (WHERE is_active) AS active_count
        FROM dictionary_items
        GROUP BY type_code
      ),
      translation_revision AS (
        SELECT i.type_code, MAX(t.revision) AS revision
        FROM dictionary_item_translations t
        JOIN dictionary_items i ON i.id = t.item_id
        GROUP BY i.type_code
      )
      SELECT
        dt.code AS type,
        GREATEST(
          COALESCE(ir.revision, 0),
          COALESCE(tr.revision, 0)
        )::int AS version,
        COALESCE(ir.active_count, 0)::int AS count
      FROM dictionary_types dt
      LEFT JOIN item_revision ir ON ir.type_code = dt.code
      LEFT JOIN translation_revision tr ON tr.type_code = dt.code
      ORDER BY dt.code
    `.execute(this.db);

    return result.rows;
  }

  /** Version of one type, for the ETag - available even when the delta is empty. */
  async typeVersion(type: string): Promise<number> {
    const versions = await this.typeVersions();
    return versions.find((v) => v.type === type)?.version ?? 0;
  }

  /**
   * Everything in a type that changed after `since`, or the full set when
   * `since` is omitted.
   *
   * Deactivations and merges arrive in `removed` rather than being dropped:
   * "deactivated" means "stop offering this in pickers", never "forget this id".
   * A merge bumps both rows' revisions, so one delta carries the losing id in
   * `removed` with its `mergedIntoId` and the surviving item in `items` - the
   * client can repoint local references without a second request (§10.3).
   */
  async delta(
    type: string,
    locale: LocaleCode,
    since: number | null,
  ): Promise<DictionaryDelta> {
    const version = await this.typeVersion(type);
    const rows = await this.resolveRows(locale, { type, since });

    const items: DictionaryItem[] = [];
    const removed: RemovedItem[] = [];

    for (const row of rows) {
      if (!row.is_active || row.merged_into_id !== null) {
        removed.push({
          id: row.id,
          reason: row.merged_into_id !== null ? 'merged' : 'inactive',
          mergedIntoId: row.merged_into_id,
        });
        continue;
      }

      items.push(toItem(row));
    }

    return {
      type,
      locale,
      version,
      since,
      isFull: since === null,
      items,
      removed,
    };
  }

  /**
   * Resolves specific ids, whatever their state.
   *
   * Exists so a historical record can be rendered - an application against a
   * vacancy whose occupation was later merged, for instance. Without it the
   * client's only options are a stale cache or showing a raw code, and §3.2
   * forbids the second.
   */
  async itemsByIds(
    ids: string[],
    locale: LocaleCode,
  ): Promise<DictionaryItem[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.resolveRows(locale, { ids });
    return rows.map(toItem);
  }

  /**
   * The facts a write path needs about the ids it was handed.
   *
   * Labels are deliberately absent: this answers "may this id be stored in this
   * field", which is a question about type, activity and hierarchy. One query for
   * every id in a request, because the alternative - a lookup per field - turns a
   * profile save into a dozen round trips.
   *
   * Inactive and merged items come back with their flags rather than being
   * omitted, so a caller can tell "no such item" from "that one was retired",
   * which are different messages to a user.
   */
  async lookupForValidation(
    ids: string[],
  ): Promise<Map<string, DictionaryItemFacts>> {
    const facts = new Map<string, DictionaryItemFacts>();

    if (ids.length === 0) {
      return facts;
    }

    const rows = await this.db
      .selectFrom('dictionary_items')
      .select([
        'id',
        'type_code',
        'item_group',
        'category',
        'parent_id',
        'rank',
        'is_active',
        'merged_into_id',
      ])
      .where('id', 'in', ids)
      .execute();

    for (const row of rows) {
      facts.set(row.id, {
        id: row.id,
        typeCode: row.type_code,
        group: row.item_group,
        category: row.category,
        parentId: row.parent_id,
        rank: row.rank,
        isActive: row.is_active,
        mergedIntoId: row.merged_into_id,
      });
    }

    return facts;
  }

  /**
   * The one label-resolution query.
   *
   * Every read goes through here so the fallback chain of §3.2 cannot differ
   * between endpoints. The lateral join picks the best available label by the
   * chain's order and, failing that, any label at all - a request must never
   * return a bare code as a display value.
   */
  private async resolveRows(
    locale: LocaleCode,
    filter: { type?: string; since?: number | null; ids?: string[] },
  ): Promise<ResolvedRow[]> {
    const chain = localeFallbackChain(locale);
    const type = filter.type ?? null;
    const since = filter.since ?? null;
    const ids = filter.ids ?? null;

    const result = await sql<ResolvedRow>`
      SELECT
        i.id,
        i.code,
        label.label,
        label.locale AS label_locale,
        i.category,
        i.item_group,
        i.parent_id,
        i.sort_order,
        i.rank,
        i.is_active,
        i.merged_into_id,
        GREATEST(i.revision, COALESCE(translation.revision, 0))::int
          AS effective_revision
      FROM dictionary_items i
      LEFT JOIN LATERAL (
        SELECT t.label, t.locale
        FROM dictionary_item_translations t
        WHERE t.item_id = i.id
        -- Preferred locales first, in chain order; anything else last, so a
        -- partially translated historical item still renders a real label.
        ORDER BY
          COALESCE(array_position(${sql.val(chain)}::text[], t.locale::text), 99),
          t.locale
        LIMIT 1
      ) label ON true
      LEFT JOIN LATERAL (
        SELECT MAX(t2.revision) AS revision
        FROM dictionary_item_translations t2
        WHERE t2.item_id = i.id
      ) translation ON true
      WHERE
        (${type}::text IS NULL OR i.type_code = ${type})
        AND (${ids}::uuid[] IS NULL OR i.id = ANY(${ids}::uuid[]))
        AND (
          ${since}::int IS NULL
          OR GREATEST(i.revision, COALESCE(translation.revision, 0)) > ${since}
        )
      ORDER BY i.sort_order, i.code
    `.execute(this.db);

    return this.warnOnFallback(result.rows, locale);
  }

  /**
   * Logs label-resolution problems and drops the unrenderable rows.
   *
   * §3.2 requires a missing translation to be logged, and logging once per
   * response rather than once per row keeps a newly added untranslated item from
   * flooding the log on every picker load.
   */
  private warnOnFallback(
    rows: ResolvedRow[],
    locale: LocaleCode,
  ): ResolvedRow[] {
    const fellBack = rows.filter(
      (row) => row.label !== null && row.label_locale !== locale,
    );

    if (fellBack.length > 0) {
      this.logger.warn(
        `${fellBack.length} item(s) had no ${locale} label; served a fallback. ` +
          `First: ${fellBack[0].code}`,
      );
    }

    const untranslated = rows.filter((row) => row.label === null);

    if (untranslated.length > 0) {
      // Not reachable for an active item - the database refuses to activate one
      // without all four locales - so this is a draft or a broken import. It is
      // an error rather than a warning because the only alternatives are showing
      // a technical key, which §3.2 forbids, or omitting the item.
      this.logger.error(
        `${untranslated.length} item(s) have no label in any locale and were ` +
          `omitted. First: ${untranslated[0].code}`,
      );
    }

    return rows.filter((row) => row.label !== null);
  }
}

function toItem(row: ResolvedRow): DictionaryItem {
  return {
    id: row.id,
    code: row.code,
    // Non-null by construction: `warnOnFallback` drops rows without a label.
    label: row.label as string,
    category: row.category,
    group: row.item_group,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    rank: row.rank,
    isActive: row.is_active,
    mergedIntoId: row.merged_into_id,
  };
}
