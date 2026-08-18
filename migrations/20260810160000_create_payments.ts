import { type Kysely, sql } from 'kysely';

/**
 * M13 schema: Payment Orders and their provider event trail (§6.7, §12.6, §12.3).
 *
 * The whole milestone turns on one sentence in §6.7: *"A client-side success redirect is
 * not sufficient to credit Coins."* Everything here exists so that crediting is driven by
 * a verified provider state, and so that it can happen **once**.
 *
 * **BR-19 - "credits Coins exactly once regardless of duplicate callbacks or retries" - is
 * three constraints rather than an `if` in a handler.** They live in three places on
 * purpose, because each catches what the others cannot:
 *
 * 1. `payment_orders_provider_transaction_idx` here: one order per provider transaction.
 * 2. `wallet_transactions_one_credit_per_reference_idx`, which M12 created before there was
 *    anything to write into it: one `top_up` ledger row per order id.
 * 3. A conditional `UPDATE ... WHERE status <> 'paid'` in `PaymentOrdersService`, so the
 *    second of two simultaneous callbacks updates no rows and therefore credits nothing.
 *
 * UAT-22 delivers the same successful callback twice and is the most important test in the
 * milestone.
 *
 * **The amount is a constraint, not a calculation somebody remembers to perform.** §12.3.1
 * says client-provided totals are never trusted, so `amount_uzs = coins * coin_price_uzs`
 * is checked on the row. The price is *copied onto the order* at creation for the same
 * reason the ledger stores it (§10.5): repricing must not change what an employer already
 * owes on a checkout they have open.
 *
 * **`payment_events` is the reconciliation trail, and it is append-only** - the same three
 * statement-level triggers `wallet_transactions` and `admin_audit_log` use. Two of its
 * properties are worth reading before changing anything:
 *
 * - `order_id` is **nullable**. A callback naming an order that does not exist, or one
 *   whose signature fails, still has to be recorded: that is the only evidence a support
 *   conversation or an incident review will have, and dropping it would mean the events we
 *   most want to see are the ones we never stored.
 * - A **rejected event cannot carry a state change**, by check constraint. §12.6 requires
 *   verification "before changing the internal Payment Order state", and this makes the
 *   wrong order unrepresentable rather than merely reviewed for.
 *
 * **What is stored is the normalized event, never the provider's raw body.** §12.6 says to
 * "log only non-sensitive identifiers required for support and audit", so each adapter
 * hands over the fields this system understands - method, provider transaction id, amount,
 * order reference, verification result - and nothing else is kept. Redacting a raw payload
 * would mean maintaining a denylist forever; not holding one cannot leak.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // Two values, because two providers are required (§6.7). §12.7 anticipates Apple IAP and
  // Google Play as a third and fourth, and the cost of that is deliberately visible here:
  // one `ALTER TYPE ... ADD VALUE`, one adapter behind `PaymentProvider`, and **no change
  // to the ledger or to Candidate Unlock**. `wallet_transactions` has no provider column at
  // all, which is what "the wallet ledger remains payment-provider agnostic" means in
  // schema terms.
  await sql`CREATE TYPE payment_provider AS ENUM ('payme', 'click')`.execute(
    db,
  );

  // §6.7 names the statuses. `reversed` covers the specification's "REVERSED/REFUNDED":
  // one state, because what separates those two words is who initiated it, which the event
  // trail records and the order's status does not need to.
  await sql`
    CREATE TYPE payment_order_status AS ENUM (
      'created',
      'pending',
      'paid',
      'failed',
      'cancelled',
      'reversed'
    )
  `.execute(db);

  await sql`
    CREATE TYPE payment_event_result AS ENUM ('verified', 'rejected')
  `.execute(db);

  await db.schema
    .createTable('payment_orders')
    // The internal order id §6.7 requires. The provider carries it back as its account or
    // `merchant_trans_id`, so it is also the join key for reconciliation.
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    // `restrict`, like the wallet itself: §6.7 requires payment records to be kept "for
    // support and reconciliation", so no cascade may reach one. BR-14's purge anonymizes
    // these accounts instead of deleting them, which migration 20 already established.
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.references('employer_wallets.user_id').onDelete('restrict').notNull(),
    )
    .addColumn('provider', sql`payment_provider`, (col) => col.notNull())
    .addColumn('coins', 'integer', (col) => col.notNull())
    // The price quoted when the order was created, not today's. An employer who opened a
    // checkout before a repricing owes what they were quoted (§10.5).
    .addColumn('coin_price_uzs', 'numeric(14, 2)', (col) => col.notNull())
    // Recalculated server-side, and checked below (§12.3.1).
    .addColumn('amount_uzs', 'numeric(14, 2)', (col) => col.notNull())
    .addColumn('status', sql`payment_order_status`, (col) =>
      col.notNull().defaultTo('created'),
    )
    // The provider's own transaction id, absent until the provider creates one.
    .addColumn('provider_transaction_id', 'text')
    // Non-sensitive provider identifiers kept for support (§12.6): never card data, and
    // never a credential.
    .addColumn('provider_metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    // Set by the same statement that reaches `paid`, so "when was this paid" never has to
    // be inferred from the event trail.
    .addColumn('paid_at', 'timestamptz')
    // Why a terminal failure happened, as a stable code. §12.6: "Failed and cancelled
    // flows return the user to Wallet with a clear status and retry option."
    .addColumn('failure_code', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint('payment_orders_coins_positive', sql`coins > 0`)
    .addCheckConstraint(
      'payment_orders_price_positive',
      sql`coin_price_uzs > 0`,
    )
    // §12.3.1, as arithmetic on the row: a client-supplied total cannot survive here even
    // if some future caller passed one through.
    .addCheckConstraint(
      'payment_orders_amount_derived',
      sql`amount_uzs = coins * coin_price_uzs`,
    )
    // A paid order that cannot be traced to a provider transaction is unreconcilable, and
    // §6.7 exists to make reconciliation possible. Both halves are required together.
    .addCheckConstraint(
      'payment_orders_paid_is_traceable',
      sql`
        status <> 'paid'
        OR (provider_transaction_id IS NOT NULL AND paid_at IS NOT NULL)
      `,
    )
    // `paid_at` is only meaningful for money that arrived. A reversal keeps it: the payment
    // did happen, and then it was given back.
    .addCheckConstraint(
      'payment_orders_paid_at_only_when_paid',
      sql`paid_at IS NULL OR status IN ('paid', 'reversed')`,
    )
    .execute();

  // BR-19's first constraint: a provider transaction identifies exactly one order, so a
  // callback cannot be replayed against a different one.
  await sql`
    CREATE UNIQUE INDEX payment_orders_provider_transaction_idx
      ON payment_orders (provider, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL
  `.execute(db);

  // The employer's own list, newest first - §6.7 requires the status to be visible in
  // Wallet, including for a retry.
  await sql`
    CREATE INDEX payment_orders_employer_created_idx
      ON payment_orders (employer_user_id, created_at DESC)
  `.execute(db);

  await db.schema
    .createTable('payment_events')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    // Nullable on purpose - see the header. An unverifiable callback is exactly the event
    // worth keeping, and it has no order to attach itself to.
    .addColumn('order_id', 'uuid', (col) =>
      col.references('payment_orders.id').onDelete('restrict'),
    )
    .addColumn('provider', sql`payment_provider`, (col) => col.notNull())
    // The provider's own method name: `PerformTransaction`, `Complete`, and so on. Text
    // rather than an enum because it is *their* vocabulary, and a provider adding a method
    // must not require a migration here.
    .addColumn('method', 'text', (col) => col.notNull())
    .addColumn('result', sql`payment_event_result`, (col) => col.notNull())
    // A stable machine code: why it was rejected, or which transition it caused.
    .addColumn('detail', 'text')
    .addColumn('provider_transaction_id', 'text')
    // The transition, when there was one. Both null for a verification check or a status
    // poll, neither of which moves the order.
    .addColumn('status_before', sql`payment_order_status`)
    .addColumn('status_after', sql`payment_order_status`)
    // What the provider said the amount was - kept even when it is the reason for the
    // rejection, because "they asked for the wrong amount" is only provable if it is
    // stored.
    .addColumn('amount_uzs', 'numeric(14, 2)')
    // The normalized event, never the raw body.
    .addColumn('payload', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // §12.6: verification comes **before** any state change. A rejected event that recorded
    // a transition would mean that ordering had been broken somewhere, so it is made
    // impossible to write rather than something to review for.
    .addCheckConstraint(
      'payment_events_rejected_changes_nothing',
      sql`result <> 'rejected' OR status_after IS NULL`,
    )
    // A transition belongs to an order, and it comes from somewhere.
    .addCheckConstraint(
      'payment_events_transition_is_complete',
      sql`
        status_after IS NULL
        OR (order_id IS NOT NULL AND status_before IS NOT NULL)
      `,
    )
    .execute();

  // §12.3: the audit trail for one order, and the lookup a provider's own reconciliation
  // call (`CheckTransaction`, `GetStatement`) needs.
  await sql`
    CREATE INDEX payment_events_order_created_idx
      ON payment_events (order_id, created_at DESC)
  `.execute(db);

  await sql`
    CREATE INDEX payment_events_provider_transaction_idx
      ON payment_events (provider, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL
  `.execute(db);

  // Append-only, for the same reason the ledger is: this is the trail that answers "why was
  // this credited", and a trail that can be edited answers nothing. Statement-level because
  // a row trigger never fires for an `UPDATE` matching no rows, which is the one-line way
  // around a row-level one.
  await sql`
    CREATE OR REPLACE FUNCTION payment_events_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'payment_events is append-only: % refused (SPEC 12.3). '
        'Append a new event instead.', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  for (const op of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    await sql`
      CREATE TRIGGER ${sql.raw(`payment_events_no_${op.toLowerCase()}`)}
        BEFORE ${sql.raw(op)} ON payment_events
        FOR EACH STATEMENT EXECUTE FUNCTION payment_events_append_only()
    `.execute(db);
  }

  await db
    .updateTable('app_meta')
    .set({ value: '21', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  // The triggers go with the table; the function does not.
  await db.schema.dropTable('payment_events').execute();
  await sql`DROP FUNCTION payment_events_append_only()`.execute(db);
  await db.schema.dropTable('payment_orders').execute();
  await sql`DROP TYPE payment_event_result`.execute(db);
  await sql`DROP TYPE payment_order_status`.execute(db);
  await sql`DROP TYPE payment_provider`.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '20', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
