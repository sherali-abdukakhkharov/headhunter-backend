import { type Kysely, sql } from 'kysely';

/**
 * The wallet ledger outlives the account, so the purge must not try to delete it.
 *
 * Found by a test, and it is the second instance of a collision M10 met first. `users` had
 * sixteen cascades hanging off it; M12 added a seventeenth to `employer_wallets`, which
 * cascades on to `wallet_transactions` - a table with a trigger that **refuses `DELETE`**
 * (BR-24). So deleting any employer who has ever held a Coin failed with
 * "wallet_transactions is append-only", from inside a cascade, in a purge that had already
 * begun. The error was correct and the design around it was not.
 *
 * **The fix is to make the refusal happen at the top rather than half way down.**
 * `employer_wallets.user_id` becomes `ON DELETE RESTRICT`: an attempt to delete an
 * employer with a wallet now fails immediately and legibly, and `RetentionService` treats
 * a wallet exactly as it already treats an audit row - the person is erased and the record
 * is kept.
 *
 * That is not a workaround, it is what the specification asks for. §6.7 requires payment
 * records to be stored "for support and reconciliation" and leaves fiscal receipt
 * attributes, VAT and merchant configuration to the client's accounting function; BR-24
 * makes the ledger append-only. A financial history that disappeared when somebody closed
 * their account would satisfy none of that. BR-14's erasure duty is met the same way it is
 * met for administrators: the identity goes, the row stays, and what is left is a Coin
 * balance attached to an id nobody can resolve to a person.
 *
 * `candidate_unlocks` already pointed at the candidate with `RESTRICT` for the same
 * reason - an employer paid for that row - so this makes the two sides consistent.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE employer_wallets
      DROP CONSTRAINT employer_wallets_user_id_fkey
  `.execute(db);

  await sql`
    ALTER TABLE employer_wallets
      ADD CONSTRAINT employer_wallets_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '20', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE employer_wallets
      DROP CONSTRAINT employer_wallets_user_id_fkey
  `.execute(db);

  // Back to `cascade`, which is what it was - and which cannot actually delete anything,
  // because the ledger's trigger refuses the cascade. Rolling this back restores the bug
  // rather than a working state; it exists so the migration is reversible, not so anybody
  // runs it.
  await sql`
    ALTER TABLE employer_wallets
      ADD CONSTRAINT employer_wallets_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '19', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
