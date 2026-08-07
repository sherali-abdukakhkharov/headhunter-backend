import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';

import { AUDIT_ACTIONS, AuditService } from './audit.service';

export interface DictionaryItemInput {
  code: string;
  /**
   * Any subset on creation, all four before activation.
   *
   * Partial rather than complete on purpose: an administrator adding an item they have
   * three translations for should be able to save the draft, and the database is what
   * refuses to *activate* it (§3.2) - one definition of "complete", in the constraint that
   * derives it from the `locale_code` enum.
   */
  labels: Partial<Record<LocaleCode, string>>;
  category?: DictionaryCategory | null;
  group?: string | null;
  rank?: number | null;
  sortOrder?: number;
  /** A district's region, for the one self-referencing type (§10.3's regions row). */
  parentId?: string | null;
  isActive?: boolean;
}

export interface DictionaryItemPatch {
  category?: DictionaryCategory | null;
  group?: string | null;
  rank?: number | null;
  sortOrder?: number;
  parentId?: string | null;
  labels?: Partial<Record<LocaleCode, string>>;
}

/**
 * §10.3's dictionary management.
 *
 * The table in §10.3 lists six dictionaries and their actions, and they reduce to five
 * operations over one pair of tables: create, edit (metadata or labels), activate,
 * deactivate, merge. There is no per-type service, because BR-13 makes every type the same
 * shape - which is the whole reason the dictionary is generic.
 *
 * Four rules this service does **not** implement, because the database already does and
 * they must hold against any write path including a manual fix:
 *
 * - **All four locales before activation.** A deferrable constraint trigger refuses it,
 *   and the required count is derived from the `locale_code` enum. This service therefore
 *   writes labels and lets the activation fail if any is missing, rather than counting them
 *   itself and disagreeing.
 * - **The revision bump.** A trigger raises the global revision on every item and
 *   translation write; a write path that forgot would raise no error at all and simply
 *   leave every client's cache stale for ever.
 * - **A merge bumps both rows**, so one delta carries the loser in `removed` and the
 *   survivor in `items`.
 * - **Nothing is ever hard-deleted** (CLAUDE.md): deactivate, or merge into a survivor, so
 *   historical references still resolve. There is no delete method here at all.
 */
@Injectable()
export class DictionaryAdminService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** §10.3's "create", for any type. */
  async create(
    actorUserId: string,
    typeCode: string,
    input: DictionaryItemInput,
  ): Promise<string> {
    await this.assertTypeExists(typeCode);

    const duplicate = await this.db
      .selectFrom('dictionary_items')
      .select('id')
      .where('type_code', '=', typeCode)
      .where('code', '=', input.code)
      .executeTakeFirst();

    // A duplicate code would silently shadow the first row in every lookup by code, which
    // is how the seed's own invariant test is written.
    if (duplicate) {
      throw new ConflictError('dictionary.code_taken');
    }

    return this.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('dictionary_items')
        .values({
          type_code: typeCode,
          code: input.code,
          category: input.category ?? null,
          item_group: input.group ?? null,
          rank: input.rank ?? null,
          sort_order: input.sortOrder ?? 0,
          parent_id: input.parentId ?? null,
          // Inactive by default: a new item with no labels must not appear in a picker,
          // and the caller activates it once they are written.
          is_active: input.isActive ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.writeLabels(trx, created.id, input.labels);

      await this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.dictionaryItemCreated,
        targetType: 'dictionary_item',
        targetId: created.id,
        details: { typeCode, code: input.code },
      });

      return created.id;
    });
  }

  /** §10.3's "edit", "assign category" and "maintain localized labels". */
  async update(
    actorUserId: string,
    itemId: string,
    patch: DictionaryItemPatch,
  ): Promise<void> {
    const item = await this.item(itemId);

    await this.db.transaction().execute(async (trx) => {
      const columns: Record<string, unknown> = {};

      if (patch.category !== undefined) {
        columns.category = patch.category;
      }

      if (patch.group !== undefined) {
        columns.item_group = patch.group;
      }

      if (patch.rank !== undefined) {
        columns.rank = patch.rank;
      }

      if (patch.sortOrder !== undefined) {
        columns.sort_order = patch.sortOrder;
      }

      if (patch.parentId !== undefined) {
        columns.parent_id = patch.parentId;
      }

      if (Object.keys(columns).length > 0) {
        await trx
          .updateTable('dictionary_items')
          .set({ ...columns, updated_at: sql`now()` })
          .where('id', '=', itemId)
          .execute();
      }

      if (patch.labels) {
        await this.writeLabels(trx, itemId, patch.labels);
      }

      await this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.dictionaryItemUpdated,
        targetType: 'dictionary_item',
        targetId: itemId,
        details: {
          typeCode: item.type_code,
          code: item.code,
          // The keys that changed, not their values: this is a trail, and the values are
          // one read away in the dictionary itself.
          changed: [
            ...Object.keys(columns),
            ...(patch.labels ? ['labels'] : []),
          ],
        },
      });
    });
  }

  /**
   * §10.3's "activate/deactivate".
   *
   * Activation can fail on the four-locale constraint, and that is deliberate: this
   * service does not pre-check it, because the constraint is derived from the
   * `locale_code` enum and a second count here would be a second definition of "complete".
   */
  async setActive(
    actorUserId: string,
    itemId: string,
    isActive: boolean,
  ): Promise<void> {
    const item = await this.item(itemId);

    if (item.is_active === isActive) {
      throw new ConflictError('dictionary.state_unchanged');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('dictionary_items')
        .set({ is_active: isActive, updated_at: sql`now()` })
        .where('id', '=', itemId)
        .execute();

      await this.audit.record(trx, {
        actorUserId,
        action: isActive
          ? AUDIT_ACTIONS.dictionaryItemUpdated
          : AUDIT_ACTIONS.dictionaryItemDeactivated,
        targetType: 'dictionary_item',
        targetId: itemId,
        details: { typeCode: item.type_code, code: item.code, isActive },
      });
    });
  }

  /**
   * §10.3's "merge duplicates", which the skills row asks for by name.
   *
   * The loser is deactivated and points at the survivor through `merged_into_id`, so every
   * profile and vacancy that referenced it still resolves - which is what
   * `GET /dictionaries/items?ids=` uses to answer for historical records. Nothing is
   * rewritten and nothing is deleted: rewriting thousands of rows to tidy a picker would
   * be a migration disguised as an edit.
   */
  async merge(
    actorUserId: string,
    loserId: string,
    survivorId: string,
  ): Promise<void> {
    if (loserId === survivorId) {
      throw new ForbiddenError('dictionary.merge_into_itself');
    }

    const [loser, survivor] = await Promise.all([
      this.item(loserId),
      this.item(survivorId),
    ]);

    if (loser.type_code !== survivor.type_code) {
      // Merging across types would make a skill resolve to an industry.
      throw new ForbiddenError('dictionary.merge_type_mismatch');
    }

    if (survivor.merged_into_id) {
      // Merging into something already merged would build a chain readers have to walk.
      throw new ConflictError('dictionary.survivor_already_merged');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('dictionary_items')
        .set({
          merged_into_id: survivorId,
          is_active: false,
          updated_at: sql`now()`,
        })
        .where('id', '=', loserId)
        .execute();

      // The survivor's own revision is bumped by the trigger on this write, so one delta
      // carries both sides of the merge - see the dictionary migration.
      await trx
        .updateTable('dictionary_items')
        .set({ updated_at: sql`now()` })
        .where('id', '=', survivorId)
        .execute();

      await this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.dictionaryItemsMerged,
        targetType: 'dictionary_item',
        targetId: loserId,
        details: {
          typeCode: loser.type_code,
          loser: loser.code,
          survivor: survivor.code,
          survivorId,
        },
      });
    });
  }

  private async writeLabels(
    trx: Database,
    itemId: string,
    labels: Partial<Record<LocaleCode, string>>,
  ): Promise<void> {
    const rows = Object.entries(labels)
      .filter(([, label]) => label !== undefined && label !== null)
      .map(([locale, label]) => ({
        item_id: itemId,
        locale: locale as LocaleCode,
        label: label,
      }));

    if (rows.length === 0) {
      return;
    }

    await trx
      .insertInto('dictionary_item_translations')
      .values(rows)
      .onConflict((oc) =>
        oc
          .columns(['item_id', 'locale'])
          .doUpdateSet((eb) => ({ label: eb.ref('excluded.label') })),
      )
      .execute();
  }

  private async item(itemId: string) {
    const row = await this.db
      .selectFrom('dictionary_items')
      .select(['id', 'type_code', 'code', 'is_active', 'merged_into_id'])
      .where('id', '=', itemId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('dictionary.item_not_found');
    }

    return row;
  }

  private async assertTypeExists(typeCode: string): Promise<void> {
    const row = await this.db
      .selectFrom('dictionary_types')
      .select('code')
      .where('code', '=', typeCode)
      .executeTakeFirst();

    // The types are frozen by API_CONTRACTS §3.1, so adding one is a release rather than
    // an administrator's action - and a typo here would create an invisible dictionary.
    if (!row) {
      throw new NotFoundError('dictionary.type_not_found');
    }
  }
}
