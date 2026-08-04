import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely database schema.
 *
 * Regenerate from the live database after adding a migration:
 *
 *   pnpm kysely:generate
 *
 * Hand edits are fine before the first codegen run, but once `kysely:generate`
 * is wired to CI this file is generated output - change the migration instead.
 */

/** A timestamp column: string/Date accepted on write, Date returned on read. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AppMeta {
  key: string;
  value: string;
  updated_at: Generated<Timestamp>;
}

export interface DB {
  app_meta: AppMeta;
}
