import { type Kysely, sql } from 'kysely';

/**
 * M12 schema: the employer Coin wallet, its ledger, and Candidate Unlock (§6.6, §12.3.1).
 *
 * This is the first money in the product, and §12.3.1 states its guarantees as
 * requirements rather than leaving them to a service. Every one of them is a constraint
 * here, because a rule about money that lives only in application code is a rule that
 * holds until the second caller.
 *
 * **The ledger is the truth; the balance is a cache.** `wallet_transactions` is
 * append-only and every row carries `balance_before` and `balance_after`, so the whole
 * history can be replayed and checked. `employer_wallets.balance_coins` exists only so
 * reading a balance is not a sum over history - an integration test asserts the two agree
 * after every kind of transaction, which is the only way a cache like this stays honest.
 *
 * **Append-only is enforced by three statement-level triggers**, the same shape M10 used
 * for `admin_audit_log`: `UPDATE`, `DELETE` and `TRUNCATE` are all refused. Statement-level
 * because a row trigger never fires for an `UPDATE` that matches nothing, so
 * `UPDATE ... WHERE false` would report a success it did not perform. BR-24 - "the wallet
 * ledger is append-only; reversals and administrator adjustments are separate audited
 * transaction entries" - is therefore a property of the table.
 *
 * **Three uniqueness rules do the work three checks would get wrong under concurrency:**
 *
 * - `candidate_unlocks` is keyed on `(employer_user_id, candidate_user_id)`. BR-16's
 *   "charged once per employer-candidate pair" is that primary key; two taps on the same
 *   button race, and the database picks a winner.
 * - A **partial unique index** allows one `registration_bonus` row per employer. BR-15's
 *   "exactly once, and not again after logout, reinstall, device change, or role
 *   switching" reads like four rules and is one: each of those is a retry of the same
 *   insert, and a unique index answers all four.
 * - `wallet_transactions.reference_id` is unique per kind where it is set, so a top-up
 *   cannot credit the same payment order twice (BR-19). M13 fills that in; the constraint
 *   exists now because adding it later would mean auditing the rows written in between.
 *
 * **Amounts are integers.** Coins are whole units by definition (§6.6), and the UZS value
 * of a transaction is stored in `numeric(14,2)` alongside the Coin count rather than being
 * recomputed from today's price - §10.5 requires that repricing "affects future
 * transactions only and does not rewrite historical ledger records", which is impossible
 * if the value is derived at read time.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TYPE wallet_transaction_kind AS ENUM (
      'registration_bonus',
      'top_up',
      'candidate_unlock',
      'admin_adjustment',
      'reversal'
    )
  `.execute(db);

  await db.schema
    .createTable('employer_wallets')
    // The employer's own user id: one wallet per employer, and nothing to look up.
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade').notNull(),
    )
    // The cache. Never written except beside a ledger row, and checked against the sum.
    .addColumn('balance_coins', 'integer', (col) => col.notNull().defaultTo(0))
    // §6.6's "one-time bonus": this records when, and the partial index below records
    // that it can only have happened once.
    .addColumn('registration_bonus_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // A negative balance is not a state this product has: the unlock refuses when there
    // are too few Coins, so reaching one would mean the debit lost a race it should have
    // lost at the constraint instead.
    .addCheckConstraint(
      'employer_wallets_balance_non_negative',
      sql`balance_coins >= 0`,
    )
    .execute();

  await db.schema
    .createTable('wallet_transactions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.references('employer_wallets.user_id').onDelete('cascade').notNull(),
    )
    .addColumn('kind', sql`wallet_transaction_kind`, (col) => col.notNull())
    // Signed: a debit is negative, so the sum of this column *is* the balance and a
    // separate direction column cannot disagree with it.
    .addColumn('amount_coins', 'integer', (col) => col.notNull())
    .addColumn('balance_before', 'integer', (col) => col.notNull())
    .addColumn('balance_after', 'integer', (col) => col.notNull())
    // The money value at the time of the transaction, never recomputed (§10.5).
    .addColumn('coin_price_uzs', 'numeric(14, 2)')
    .addColumn('amount_uzs', 'numeric(14, 2)')
    // What this transaction was for: a candidate id for an unlock, a payment order for a
    // top-up, the reversed transaction for a reversal.
    .addColumn('reference_id', 'uuid')
    // Mandatory for an administrator adjustment (§10.5), and the check below says so
    // rather than the service remembering to.
    .addColumn('reason', 'text')
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // The arithmetic has to hold on its own row. A ledger whose `balance_after` did not
    // follow from its own amount would be unreplayable, and the bug would be invisible
    // until somebody summed the column.
    .addCheckConstraint(
      'wallet_transactions_arithmetic',
      sql`balance_after = balance_before + amount_coins`,
    )
    .addCheckConstraint(
      'wallet_transactions_balance_non_negative',
      sql`balance_before >= 0 AND balance_after >= 0`,
    )
    // §10.5: "only with a mandatory reason".
    .addCheckConstraint(
      'wallet_transactions_adjustment_has_reason',
      sql`kind <> 'admin_adjustment' OR (reason IS NOT NULL AND length(btrim(reason)) >= 3)`,
    )
    // An adjustment is the one kind a person performs, so it is the one kind that must
    // name them. Everything else is the system acting on the employer's own request.
    .addCheckConstraint(
      'wallet_transactions_adjustment_has_actor',
      sql`kind <> 'admin_adjustment' OR actor_user_id IS NOT NULL`,
    )
    // Direction follows from the kind: a bonus or top-up cannot be negative, an unlock
    // cannot be positive. This is what stops a "top-up" that quietly drains a wallet.
    .addCheckConstraint(
      'wallet_transactions_direction',
      sql`
        (kind IN ('registration_bonus', 'top_up') AND amount_coins > 0)
        OR (kind = 'candidate_unlock' AND amount_coins < 0)
        OR (kind IN ('admin_adjustment', 'reversal') AND amount_coins <> 0)
      `,
    )
    .execute();

  await sql`
    CREATE INDEX wallet_transactions_employer_created_idx
      ON wallet_transactions (employer_user_id, created_at DESC)
  `.execute(db);

  // BR-15, as one index instead of four rules.
  await sql`
    CREATE UNIQUE INDEX wallet_transactions_one_bonus_idx
      ON wallet_transactions (employer_user_id)
      WHERE kind = 'registration_bonus'
  `.execute(db);

  // BR-19's half that belongs to the ledger: one credit per payment order. M13 writes
  // these rows; the constraint is here so no row can ever have been written without it.
  await sql`
    CREATE UNIQUE INDEX wallet_transactions_one_credit_per_reference_idx
      ON wallet_transactions (kind, reference_id)
      WHERE reference_id IS NOT NULL AND kind = 'top_up'
  `.execute(db);

  // BR-24: append-only, in the database. Shared with `admin_audit_log`'s function name
  // pattern rather than reusing it - the message names this table, and an operator
  // reading a constraint violation should not be sent to the wrong one.
  await sql`
    CREATE OR REPLACE FUNCTION wallet_transactions_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'wallet_transactions is append-only: % refused (SPEC BR-24). '
        'Record a reversal or an admin_adjustment instead.', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  for (const op of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    await sql`
      CREATE TRIGGER ${sql.raw(`wallet_transactions_no_${op.toLowerCase()}`)}
        BEFORE ${sql.raw(op)} ON wallet_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_transactions_append_only()
    `.execute(db);
  }

  await db.schema
    .createTable('candidate_unlocks')
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.references('employer_wallets.user_id').onDelete('cascade').notNull(),
    )
    // `restrict`, not `cascade`: an unlock is a thing the employer paid for, and a
    // candidate purging their account must not silently delete the record of a charge.
    // BR-14's purge has to answer for these rows, exactly as it does for the audit log.
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict').notNull(),
    )
    .addColumn('cost_coins', 'integer', (col) => col.notNull())
    // The ledger row that paid for it. Not null: an entitlement with no debit behind it
    // is the failure mode BR-18 exists to prevent, so it cannot be represented.
    .addColumn('transaction_id', 'uuid', (col) =>
      col.references('wallet_transactions.id').onDelete('restrict').notNull(),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // BR-16: charged once per pair. The primary key is the rule.
    .addPrimaryKeyConstraint('candidate_unlocks_pkey', [
      'employer_user_id',
      'candidate_user_id',
    ])
    .execute();

  // "Which employers have unlocked me" - the candidate's side, and the lookup a purge
  // has to make before deleting anybody.
  await sql`
    CREATE INDEX candidate_unlocks_candidate_idx
      ON candidate_unlocks (candidate_user_id)
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '19', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('candidate_unlocks').execute();
  // The triggers go with the table; the function does not.
  await db.schema.dropTable('wallet_transactions').execute();
  await sql`DROP FUNCTION wallet_transactions_append_only()`.execute(db);
  await db.schema.dropTable('employer_wallets').execute();
  await sql`DROP TYPE wallet_transaction_kind`.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '18', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
