import type { Database } from '@infra/db/database.module';
import type { LocaleCode } from '@infra/db/database.types';

import { CANONICAL_LOCALES } from '@infra/locale/locale';

import {
  DICTIONARY_SEED,
  type SeedItem,
  type SeedType,
} from './dictionary-seed.data';

export interface SeedReport {
  typesCreated: number;
  itemsCreated: number;
  itemsUpdated: number;
  labelsWritten: number;
  itemsActivated: number;
}

/**
 * Applies the dictionary seed.
 *
 * **Idempotent in the strong sense: a second run writes nothing at all.** Not
 * merely "does not duplicate" - it must not touch a row either, because every
 * item and translation write bumps the global revision by trigger. A seeder that
 * rewrote identical values would advance every type's version on each run, and
 * every client would refetch every dictionary after every deployment.
 *
 * That is why each row is read and compared before being written, rather than
 * upserted unconditionally.
 *
 * One transaction, so the deferred all-four-locales constraint (§3.2) is checked
 * at commit and an item may be inserted before its labels.
 */
export async function seedDictionaries(
  db: Database,
  seed: SeedType[] = DICTIONARY_SEED,
): Promise<SeedReport> {
  return db.transaction().execute(async (trx) => {
    const report: SeedReport = {
      typesCreated: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      labelsWritten: 0,
      itemsActivated: 0,
    };

    for (const type of seed) {
      const existingType = await trx
        .selectFrom('dictionary_types')
        .select(['code', 'has_rank'])
        .where('code', '=', type.code)
        .executeTakeFirst();

      if (!existingType) {
        await trx
          .insertInto('dictionary_types')
          .values({ code: type.code, has_rank: type.hasRank ?? false })
          .execute();
        report.typesCreated += 1;
      } else if (existingType.has_rank !== (type.hasRank ?? false)) {
        await trx
          .updateTable('dictionary_types')
          .set({ has_rank: type.hasRank ?? false })
          .where('code', '=', type.code)
          .execute();
      }

      for (const [index, item] of type.items.entries()) {
        await seedItem(trx, type, item, index * 10, report);
      }
    }

    return report;
  });
}

async function seedItem(
  trx: Database,
  type: SeedType,
  item: SeedItem,
  sortOrder: number,
  report: SeedReport,
): Promise<void> {
  assertAllLocales(type.code, item);

  const existing = await trx
    .selectFrom('dictionary_items')
    .select(['id', 'category', 'item_group', 'rank', 'sort_order', 'is_active'])
    .where('type_code', '=', type.code)
    .where('code', '=', item.code)
    .executeTakeFirst();

  let itemId: string;

  if (!existing) {
    const inserted = await trx
      .insertInto('dictionary_items')
      .values({
        type_code: type.code,
        code: item.code,
        category: item.category ?? null,
        item_group: item.group ?? null,
        rank: item.rank ?? null,
        sort_order: sortOrder,
        // Activated at the end of this function, once the labels are in place.
        // The constraint is deferred, so this is about intent rather than
        // ordering: nothing is live until it is complete.
        is_active: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    itemId = inserted.id;
    report.itemsCreated += 1;
  } else {
    itemId = existing.id;

    const changed =
      existing.category !== (item.category ?? null) ||
      existing.item_group !== (item.group ?? null) ||
      existing.rank !== (item.rank ?? null) ||
      existing.sort_order !== sortOrder;

    if (changed) {
      await trx
        .updateTable('dictionary_items')
        .set({
          category: item.category ?? null,
          item_group: item.group ?? null,
          rank: item.rank ?? null,
          sort_order: sortOrder,
          updated_at: new Date(),
        })
        .where('id', '=', itemId)
        .execute();

      report.itemsUpdated += 1;
    }
  }

  report.labelsWritten += await seedLabels(trx, itemId, item);

  // Deactivation is an administrative act (§10.3), never a side effect of a
  // seed run - so this only ever turns activation on.
  if (!existing?.is_active) {
    await trx
      .updateTable('dictionary_items')
      .set({ is_active: true, updated_at: new Date() })
      .where('id', '=', itemId)
      .execute();

    report.itemsActivated += 1;
  }
}

async function seedLabels(
  trx: Database,
  itemId: string,
  item: SeedItem,
): Promise<number> {
  const existing = await trx
    .selectFrom('dictionary_item_translations')
    .select(['locale', 'label'])
    .where('item_id', '=', itemId)
    .execute();

  const current = new Map(existing.map((row) => [row.locale, row.label]));
  let written = 0;

  for (const locale of CANONICAL_LOCALES) {
    const label = item.labels[locale];

    if (current.get(locale) === label) {
      continue;
    }

    await trx
      .insertInto('dictionary_item_translations')
      .values({ item_id: itemId, locale, label })
      .onConflict((oc) =>
        oc.columns(['item_id', 'locale']).doUpdateSet({
          label,
          updated_at: new Date(),
        }),
      )
      .execute();

    written += 1;
  }

  return written;
}

/**
 * Fails the seed on a missing label.
 *
 * The database would refuse the activation anyway, but its error names a uuid.
 * This one names the type and code, which is what someone editing the data file
 * needs to see.
 */
function assertAllLocales(typeCode: string, item: SeedItem): void {
  const missing = CANONICAL_LOCALES.filter(
    (locale: LocaleCode) => !item.labels[locale]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      `Dictionary seed ${typeCode}/${item.code} is missing labels: ${missing.join(', ')}`,
    );
  }
}
