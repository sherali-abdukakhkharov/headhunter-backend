import { type Kysely, sql } from 'kysely';

/**
 * §10.5's three money settings, made editable by an administrator.
 *
 * "Configure Coin price, Candidate Unlock cost, and the registration bonus." They were
 * environment variables, which makes a price change a redeploy and puts it outside the
 * audit log — for numbers an administrator is meant to set from a screen.
 *
 * Decisions that are not obvious from the DDL:
 *
 * - **One row per setting, not one row of columns.** A fourth number is a row rather than
 *   a migration, and the audit entry can name the key it changed.
 * - **The environment variable stays the default**, and this table holds only what has
 *   been *changed*. So a fresh deployment behaves exactly as it does today, an absent row
 *   is not a missing configuration, and deleting a row is how you revert to the declared
 *   default rather than a value somebody typed from memory.
 * - **`value_int`, not numeric.** All three are whole numbers: Coins are countable and
 *   the price is in whole so'm. A decimal column would invite half a Coin.
 * - **No history table.** The audit log already records who changed what and when
 *   (§10.4), and the *effect* of a price is recorded where it matters — every
 *   `wallet_transactions` row and every `payment_orders` row stores the price it was
 *   quoted at, so repricing cannot rewrite what somebody was charged. That is §10.5's
 *   "affects future transactions only", and it is already true.
 */
export async function up(db: Kysely<never>): Promise<void> {
  await db.schema
    .createTable('platform_settings')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value_int', 'bigint', (col) => col.notNull())
    // Who to ask about a number that surprises somebody. `set null` rather than
    // cascade: the setting outlives the administrator who last touched it, and a
    // purged account must not take the platform's prices with it.
    .addColumn('updated_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<never>): Promise<void> {
  await db.schema.dropTable('platform_settings').execute();
}
