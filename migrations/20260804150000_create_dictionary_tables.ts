import { type Kysely, sql } from 'kysely';

/**
 * M2 schema: controlled dictionaries (§3.2, §3.3, BR-13) and field-schema
 * versions.
 *
 * The one structural idea everything here serves: **an id is the only thing ever
 * stored or filtered on, and a label is a translation of it**. Selecting
 * "Call-centre operator" in any of the four interface variants must return the
 * same candidates (§3.3), which no design that persists translated text can do.
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **`revision` is a single global sequence, bumped by trigger** on every item
 *   and translation write. A type's version is the maximum revision across its
 *   rows, which is what makes `?since=` a real delta rather than a full refetch
 *   (docs/API_CONTRACTS.md §3.4). It is a trigger and not service code because a
 *   write path that forgets to bump produces no error at all - the client simply
 *   never learns about the change, and its cache is wrong until something else
 *   touches the same type.
 * - **All four locales are required before activation, enforced by a deferrable
 *   constraint trigger.** §3.2 forbids ever showing a technical key, and a
 *   half-translated item is exactly how one leaks into the UI. Deferred so a
 *   transaction may insert the item and its four labels in either order and be
 *   checked at commit. The required count is derived from the `locale_code` enum
 *   rather than hardcoded to 4, so adding a fifth interface variant tightens this
 *   automatically.
 * - **Nothing is ever hard-deleted.** `is_active = false` drops an item from
 *   pickers while keeping it resolvable for historical records, and
 *   `merged_into_id` repoints references after a skill merge (§10.3). A delete
 *   would orphan every profile and vacancy that referenced the row.
 * - **`item_group` is a second, orthogonal grouping** used only by `attribute`
 *   items (tools, transport, licence, readiness - §6.3 "additional structured
 *   requirements"). `category` cannot carry it: that column holds the five closed
 *   work categories of §2.1 and client layouts are keyed off them.
 * - **`schema_versions` exists now, ahead of the field schemas themselves**
 *   (M3/M5), because the dictionary manifest publishes those ten versions so a
 *   cold client revalidates everything in one request (API_CONTRACTS.md §3.3).
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // The five work categories of §2.1. A closed enum because client layouts and
  // icons are keyed off these values, and the field-schema endpoints are scoped
  // by them - a typo would silently produce an empty form.
  await db.schema
    .createType('dictionary_category')
    .asEnum([
      'professional',
      'service_operations',
      'physical_industrial',
      'seasonal_agricultural',
      'temporary_shift',
    ])
    .execute();

  await db.schema
    .createType('schema_target')
    .asEnum(['candidate_profile', 'vacancy'])
    .execute();

  // One global counter for both tables, so a single `since` value orders every
  // dictionary change in the system.
  await sql`CREATE SEQUENCE dictionary_revision_seq AS bigint`.execute(db);

  // dictionary_types --------------------------------------------------------
  await db.schema
    .createTable('dictionary_types')
    .addColumn('code', 'text', (col) => col.primaryKey())
    // True for the ordered scales (`skill_level`, `language_level`) whose items
    // carry a comparable `rank`. Declared per type rather than inferred, so
    // "a `>= C1` comparison is meaningful here" is a fact the data states.
    .addColumn('has_rank', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // dictionary_items --------------------------------------------------------
  await db.schema
    .createTable('dictionary_items')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('type_code', 'text', (col) =>
      col.notNull().references('dictionary_types.code').onDelete('restrict'),
    )
    // Stable machine code. Never shown to a user (§3.2) - it exists so seeds,
    // tests and migrations can refer to an item without knowing its uuid.
    .addColumn('code', 'text', (col) => col.notNull())
    // Set on occupations and work types (§2.1); null on everything else.
    .addColumn('category', sql`dictionary_category`)
    // Orthogonal grouping for `attribute` items only. See the header note.
    .addColumn('item_group', 'text')
    // region → district/city (§6.3 "Region, district/city").
    .addColumn('parent_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
    // Non-null only on the ordered scales, where `>= C1` is a range comparison
    // rather than set membership.
    .addColumn('rank', 'integer')
    // Defaults to false: an item is created, translated, and only then activated.
    // The reverse default would mean every new row is briefly live and
    // untranslated.
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(false))
    // Set on the losing row of a skill merge (§10.3), so historical references
    // still resolve and the client can repoint them.
    .addColumn('merged_into_id', 'uuid', (col) =>
      col.references('dictionary_items.id').onDelete('restrict'),
    )
    .addColumn('revision', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('dictionary_items_type_code_key', [
      'type_code',
      'code',
    ])
    .addCheckConstraint(
      'dictionary_items_no_self_merge',
      sql`merged_into_id IS NULL OR merged_into_id <> id`,
    )
    .execute();

  // The picker query: active items of one type in display order.
  await sql`
    CREATE INDEX dictionary_items_type_active_sort_idx
      ON dictionary_items (type_code, is_active, sort_order)
  `.execute(db);

  // The delta query: everything in this type changed since a revision.
  await sql`
    CREATE INDEX dictionary_items_type_revision_idx
      ON dictionary_items (type_code, revision)
  `.execute(db);

  // Region → districts, and any future hierarchy.
  await sql`
    CREATE INDEX dictionary_items_parent_idx
      ON dictionary_items (parent_id)
      WHERE parent_id IS NOT NULL
  `.execute(db);

  // dictionary_item_translations -------------------------------------------
  await db.schema
    .createTable('dictionary_item_translations')
    .addColumn('item_id', 'uuid', (col) =>
      col.notNull().references('dictionary_items.id').onDelete('cascade'),
    )
    .addColumn('locale', sql`locale_code`, (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('revision', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('dictionary_item_translations_pkey', [
      'item_id',
      'locale',
    ])
    // A blank label is worse than a missing one: it passes a not-null check and
    // renders as an empty picker row.
    .addCheckConstraint(
      'dictionary_item_translations_label_not_blank',
      sql`length(btrim(label)) > 0`,
    )
    .execute();

  // Supports "has any label of this item changed since `since`", which is what
  // makes a label edit ship the whole item in the delta.
  await sql`
    CREATE INDEX dictionary_item_translations_item_revision_idx
      ON dictionary_item_translations (item_id, revision)
  `.execute(db);

  // revision bumping --------------------------------------------------------
  await sql`
    CREATE FUNCTION dictionary_bump_revision() RETURNS trigger AS $$
    BEGIN
      NEW.revision := nextval('dictionary_revision_seq');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER dictionary_items_bump_revision
      BEFORE INSERT OR UPDATE ON dictionary_items
      FOR EACH ROW EXECUTE FUNCTION dictionary_bump_revision()
  `.execute(db);

  await sql`
    CREATE TRIGGER dictionary_item_translations_bump_revision
      BEFORE INSERT OR UPDATE ON dictionary_item_translations
      FOR EACH ROW EXECUTE FUNCTION dictionary_bump_revision()
  `.execute(db);

  // activation guard --------------------------------------------------------
  await sql`
    CREATE FUNCTION dictionary_item_require_all_locales() RETURNS trigger AS $$
    DECLARE
      required int;
      present int;
    BEGIN
      IF NOT NEW.is_active THEN
        RETURN NULL;
      END IF;

      SELECT count(*) INTO required
        FROM unnest(enum_range(NULL::locale_code));

      SELECT count(DISTINCT locale) INTO present
        FROM dictionary_item_translations
        WHERE item_id = NEW.id;

      IF present < required THEN
        RAISE EXCEPTION
          'dictionary item % cannot be active with % of % locale labels',
          NEW.id, present, required
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  // A CONSTRAINT trigger so it can be deferred to commit: a seed or an admin
  // write inserts the item and its four labels in one transaction, and the order
  // of those statements is not something callers should have to know.
  await sql`
    CREATE CONSTRAINT TRIGGER dictionary_items_require_all_locales
      AFTER INSERT OR UPDATE ON dictionary_items
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION dictionary_item_require_all_locales()
  `.execute(db);

  // schema_versions ---------------------------------------------------------
  await db.schema
    .createTable('schema_versions')
    .addColumn('target', sql`schema_target`, (col) => col.notNull())
    .addColumn('category', sql`dictionary_category`, (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('schema_versions_pkey', ['target', 'category'])
    .execute();

  // Ten rows, five categories × two targets, as the manifest contract requires.
  // Generated from the enums so this cannot drift from them.
  await sql`
    INSERT INTO schema_versions (target, category, version)
    SELECT t.target, c.category, 1
      FROM unnest(enum_range(NULL::schema_target)) AS t(target)
      CROSS JOIN unnest(enum_range(NULL::dictionary_category)) AS c(category)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '4', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('schema_versions').execute();
  await db.schema.dropTable('dictionary_item_translations').execute();
  await db.schema.dropTable('dictionary_items').execute();
  await db.schema.dropTable('dictionary_types').execute();

  await sql`DROP FUNCTION dictionary_item_require_all_locales()`.execute(db);
  await sql`DROP FUNCTION dictionary_bump_revision()`.execute(db);
  await sql`DROP SEQUENCE dictionary_revision_seq`.execute(db);

  await db.schema.dropType('schema_target').execute();
  await db.schema.dropType('dictionary_category').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '3', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
