import { randomUUID } from 'node:crypto';

import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import { requireRetentionRule } from '@infra/retention/retention-policy';

import { AuditService } from './audit.service';
import { RetentionService } from './retention.service';

/**
 * BR-14's purge against a real Postgres.
 *
 * This suite cannot be a unit test, and not only for the usual reason. The whole design
 * exists because of what the *database* does: sixteen cascades from `users`, three
 * `RESTRICT` references to `stored_files` that a naive delete trips over, and one
 * `RESTRICT` on the audit log that no amount of service code can talk its way past. Over
 * `DummyDriver` every one of those queries would compile, run nothing, and pass.
 *
 * The rows these tests create are deliberately awkward: an employer with a company logo,
 * verification evidence and a sent message, all pointing at files they own. That is the
 * shape that made a plain `DELETE FROM users` fail.
 */

let db: Database;
let destroy: () => Promise<void>;
let retention: RetentionService;

const users: string[] = [];

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  retention = new RetentionService(db, new AuditService(db));
});

afterAll(async () => {
  for (const id of users) {
    const acted = await db
      .selectFrom('admin_audit_log')
      .select('id')
      .where('actor_user_id', '=', id)
      .executeTakeFirst();

    // An employer who has held a wallet cannot be deleted either, by the same kind of
    // constraint one milestone later: `employer_wallets.user_id` is RESTRICT because §6.7
    // requires payment records for reconciliation and BR-24 forbids rewriting the ledger.
    // That is also the guarantee under test, working - `RetentionService` anonymizes these
    // accounts rather than deleting them.
    const held = await db
      .selectFrom('employer_wallets')
      .select('user_id')
      .where('user_id', '=', id)
      .executeTakeFirst();

    if (acted || held) {
      // The administrators these tests created cannot be deleted - which is the
      // guarantee under test, working.
      continue;
    }

    await db
      .deleteFrom('companies')
      .where('employer_user_id', '=', id)
      .execute();
    await db.deleteFrom('employers').where('user_id', '=', id).execute();
    await db
      .deleteFrom('stored_files')
      .where('owner_user_id', '=', id)
      .execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

/** Long past the grace period, so the account is due however the policy is edited. */
function longAgo(): Date {
  const days = (requireRetentionRule('account_personal_data').days ?? 30) + 5;

  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function newUser(
  role: 'candidate' | 'employer' | 'admin',
): Promise<string> {
  const phone = `+99895${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
}

async function storedFile(
  ownerUserId: string,
  purposeCode: string,
): Promise<string> {
  const unique = randomUUID();
  const purpose = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'file_purpose')
    .where('code', '=', purposeCode)
    .executeTakeFirstOrThrow();

  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: purpose.id,
      telegram_file_id: `fake-${unique}`,
      telegram_file_unique_id: unique,
      telegram_message_id: '1',
      file_name: `${purposeCode}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: 4,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/** Requests deletion, dated far enough back that the grace period has run out. */
async function requestDeletion(userId: string): Promise<void> {
  await db
    .insertInto('deletion_requests')
    .values({ user_id: userId, requested_at: longAgo(), reason: 'test' })
    .execute();

  await db
    .updateTable('users')
    .set({ status: 'deletion_requested' })
    .where('id', '=', userId)
    .execute();
}

/**
 * An employer whose files are referenced from all three `RESTRICT` directions.
 *
 * This is the fixture that matters: the logo, the verification evidence and the message
 * attachment are exactly what a plain `DELETE FROM users` fails on.
 */
async function employerWithEntangledFiles(): Promise<{
  userId: string;
  logoId: string;
  evidenceId: string;
}> {
  const userId = await newUser('employer');
  const logoId = await storedFile(userId, 'logo');
  const evidenceId = await storedFile(userId, 'company_registration');

  await db
    .insertInto('employers')
    .values({
      user_id: userId,
      type: 'company',
      verification_status: 'not_submitted',
    })
    .execute();
  await db
    .insertInto('companies')
    .values({
      employer_user_id: userId,
      legal_name: 'Uzum Market LLC',
      logo_file_id: logoId,
    })
    .execute();

  const submission = await db
    .insertInto('verification_submissions')
    .values({ employer_user_id: userId, status: 'under_review' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('verification_submission_files')
    .values({ submission_id: submission.id, file_id: evidenceId })
    .execute();

  return { userId, logoId, evidenceId };
}

describe('what is due (BR-14)', () => {
  it('ignores a request still inside its grace period', async () => {
    const userId = await newUser('candidate');
    await db
      .insertInto('deletion_requests')
      .values({ user_id: userId, requested_at: new Date(), reason: 'just now' })
      .execute();

    const due = await retention.due();

    expect(due.accounts.map((account) => account.userId)).not.toContain(userId);
  });

  it('ignores a request that was cancelled', async () => {
    const userId = await newUser('candidate');
    await db
      .insertInto('deletion_requests')
      .values({
        user_id: userId,
        requested_at: longAgo(),
        cancelled_at: new Date(),
        reason: 'changed their mind',
      })
      .execute();

    // Changing their mind is the whole point of the grace period, so a cancelled
    // request must not be resurrected by the next purge.
    expect((await retention.due()).accounts.map((a) => a.userId)).not.toContain(
      userId,
    );
  });

  it('names the provisional periods, so a caller cannot miss them', async () => {
    // The client has approved no privacy policy, and the API says so rather than
    // presenting an engineer's guess as policy.
    expect((await retention.due()).provisional).toContain(
      'account_personal_data',
    );
  });
});

describe('purging an ordinary account', () => {
  it('deletes the user and everything the cascades reach', async () => {
    const adminUserId = await newUser('admin');
    const { userId, logoId, evidenceId } = await employerWithEntangledFiles();
    await requestDeletion(userId);

    const outcome = await retention.purge(adminUserId);

    expect(outcome.purged).toContain(userId);
    expect(outcome.failed).toEqual([]);

    // The row is gone, not merely marked.
    expect(
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .executeTakeFirst(),
    ).toBeUndefined();

    // And so is everything that pointed at it. The two files are the interesting part:
    // a plain DELETE fails on them, because `companies.logo_file_id` and
    // `verification_submission_files.file_id` are both ON DELETE RESTRICT.
    for (const fileId of [logoId, evidenceId]) {
      expect(
        await db
          .selectFrom('stored_files')
          .select('id')
          .where('id', '=', fileId)
          .executeTakeFirst(),
      ).toBeUndefined();
    }

    expect(
      await db
        .selectFrom('employers')
        .select('user_id')
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('writes an audit row that survives the account it names', async () => {
    const adminUserId = await newUser('admin');
    const userId = await newUser('candidate');
    await requestDeletion(userId);

    await retention.purge(adminUserId);

    const audited = await db
      .selectFrom('admin_audit_log')
      .select(['action', 'target_id', 'reason'])
      .where('actor_user_id', '=', adminUserId)
      .where('target_id', '=', userId)
      .executeTakeFirst();

    // `target_id` is a bare uuid rather than a foreign key, which is exactly what lets
    // the record of an erasure outlive what it erased.
    expect(audited).toMatchObject({ action: 'user.purged' });
    expect(audited?.reason).toContain('BR-14');
  });
});

describe('purging an account that has acted as an administrator', () => {
  it('erases the person and keeps the actor (§10.4 versus BR-14)', async () => {
    const purgerUserId = await newUser('admin');
    const retiringAdminId = await newUser('admin');
    const targetUserId = await newUser('candidate');

    // As the seeder would have left them: an administrator has no profile, so their name
    // lives on the account itself and BR-14 has to reach it there.
    await db
      .updateTable('users')
      .set({ full_name: 'Abduqaxxarov Sherali' })
      .where('id', '=', retiringAdminId)
      .execute();

    // The retiring administrator does something auditable, which is what makes their
    // row undeletable.
    await db.transaction().execute((trx) =>
      new AuditService(db).record(trx, {
        actorUserId: retiringAdminId,
        action: 'user.warned',
        targetType: 'user',
        targetId: targetUserId,
        reason: 'Told them to stop.',
      }),
    );

    await requestDeletion(retiringAdminId);

    const due = await retention.due();
    const planned = due.accounts.find((a) => a.userId === retiringAdminId);
    expect(planned).toMatchObject({ action: 'anonymize', auditRows: 1 });

    const outcome = await retention.purge(purgerUserId);
    expect(outcome.anonymized).toContain(retiringAdminId);
    expect(outcome.purged).not.toContain(retiringAdminId);

    const after = await db
      .selectFrom('users')
      .select([
        'id',
        'phone',
        'telegram_user_id',
        'full_name',
        'purged_at',
        'last_login_at',
      ])
      .where('id', '=', retiringAdminId)
      .executeTakeFirstOrThrow();

    // The person is gone: no phone, no Telegram identity, no name, no login history.
    expect(after.phone).toBeNull();
    expect(after.telegram_user_id).toBeNull();
    expect(after.full_name).toBeNull();
    expect(after.last_login_at).toBeNull();
    expect(after.purged_at).toBeInstanceOf(Date);

    // The actor is not: the decision they made still resolves to a distinct
    // administrator, without naming one.
    const trail = await db
      .selectFrom('admin_audit_log')
      .select(['actor_user_id', 'action'])
      .where('actor_user_id', '=', retiringAdminId)
      .execute();

    expect(trail).toEqual([
      expect.objectContaining({
        actor_user_id: retiringAdminId,
        action: 'user.warned',
      }),
    ]);

    // And they are no longer an administrator, because nobody can sign into the account.
    expect(
      await db
        .selectFrom('user_roles')
        .select('role')
        .where('user_id', '=', retiringAdminId)
        .execute(),
    ).toEqual([]);
  });

  it('refuses to leave a credential on a purged row, by constraint', async () => {
    const userId = await newUser('candidate');

    // The service cannot write this, but the point is that nothing can: a future purge
    // that forgot the phone number would be refused by the table rather than succeed
    // quietly. This is the check the whole migration exists for.
    await expect(
      db
        .updateTable('users')
        .set({ purged_at: new Date() })
        .where('id', '=', userId)
        .execute(),
    ).rejects.toThrow(/users_purged_has_no_credential/);
  });

  it('does not purge the same account twice', async () => {
    const purgerUserId = await newUser('admin');
    const retiringAdminId = await newUser('admin');

    await db.transaction().execute((trx) =>
      new AuditService(db).record(trx, {
        actorUserId: retiringAdminId,
        action: 'user.warned',
        targetType: 'user',
        targetId: retiringAdminId,
        reason: 'A note to self.',
      }),
    );
    await requestDeletion(retiringAdminId);

    await retention.purge(purgerUserId);
    const second = await retention.purge(purgerUserId);

    // The anonymized row still has an open deletion request - it cannot be deleted, so
    // the request cannot cascade away - and `purged_at` is what stops it coming back
    // round on every run.
    expect(second.anonymized).not.toContain(retiringAdminId);
    expect(second.purged).not.toContain(retiringAdminId);
  });
});

describe('the transient sweeps', () => {
  it('removes an expired OTP row and reports how many', async () => {
    const cutoffDays = requireRetentionRule('otp_codes').days ?? 1;
    const old = new Date(Date.now() - (cutoffDays + 1) * 24 * 60 * 60 * 1000);
    const phone = `+99894${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;

    await db
      .insertInto('otp_codes')
      .values({
        phone,
        purpose: 'login',
        code_hash: 'hash',
        expires_at: old,
        created_at: old,
      })
      .execute();

    const adminUserId = await newUser('admin');
    const outcome = await retention.purge(adminUserId);

    expect(
      outcome.transient.find((entry) => entry.code === 'otp_codes')?.rows ?? 0,
    ).toBeGreaterThan(0);

    expect(
      await db
        .selectFrom('otp_codes')
        .select('id')
        .where('phone', '=', phone)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('leaves a live counter alone', async () => {
    const subject = `perf-${randomUUID()}`;
    await db
      .insertInto('rate_limit_counters')
      .values({
        bucket: 'search',
        subject,
        window_start: new Date(),
        hits: 3,
      })
      .execute();

    const adminUserId = await newUser('admin');
    await retention.purge(adminUserId);

    // A counter inside its window is still enforcing a limit; removing it would hand
    // back a budget somebody has already spent.
    expect(
      await db
        .selectFrom('rate_limit_counters')
        .select('hits')
        .where('subject', '=', subject)
        .executeTakeFirst(),
    ).toMatchObject({ hits: 3 });

    await db
      .deleteFrom('rate_limit_counters')
      .where('subject', '=', subject)
      .execute();
  });
});

/**
 * BR-14 versus the wallet ledger (M12).
 *
 * The second collision of the same shape as the audit log, and it was found by an M12 test
 * rather than by design: `employer_wallets` cascades to an append-only ledger, so deleting
 * an employer who had ever held a Coin failed *inside* the cascade with
 * "wallet_transactions is append-only". Financial history has to outlive the account
 * (BR-24, §6.7), so the answer is the one already established for administrators - erase
 * the person, keep the record.
 */
describe('an account with financial history', () => {
  it('is anonymized rather than deleted, and the ledger survives', async () => {
    const adminUserId = await newUser('admin');
    const employerUserId = await newUser('employer');

    // A wallet with a single transaction is enough: one Coin of history is history.
    await db
      .insertInto('employer_wallets')
      .values({ user_id: employerUserId, balance_coins: 10 })
      .execute();
    await db
      .insertInto('wallet_transactions')
      .values({
        employer_user_id: employerUserId,
        kind: 'registration_bonus',
        amount_coins: 10,
        balance_before: 0,
        balance_after: 10,
      })
      .execute();

    await requestDeletion(employerUserId);

    const planned = (await retention.due()).accounts.find(
      (account) => account.userId === employerUserId,
    );
    expect(planned).toMatchObject({ action: 'anonymize', walletRows: 1 });

    const outcome = await retention.purge(adminUserId);
    expect(outcome.anonymized).toContain(employerUserId);
    expect(outcome.failed).toEqual([]);

    // The person is gone.
    const after = await db
      .selectFrom('users')
      .select(['phone', 'purged_at'])
      .where('id', '=', employerUserId)
      .executeTakeFirstOrThrow();
    expect(after.phone).toBeNull();
    expect(after.purged_at).toBeInstanceOf(Date);

    // The money is not. A balance against an id nobody can resolve to a person is
    // exactly what §6.7's reconciliation needs and what BR-14 permits.
    expect(
      await db
        .selectFrom('wallet_transactions')
        .select('amount_coins')
        .where('employer_user_id', '=', employerUserId)
        .execute(),
    ).toEqual([expect.objectContaining({ amount_coins: 10 })]);
  });

  it('is anonymized for holding a wallet at all, not for holding history in it', async () => {
    // **The case that made this a real defect rather than a tidy-up.** The purge used to
    // decide on the number of `wallet_transactions` rows, but the constraint that refuses the
    // delete is `employer_wallets.user_id`'s `RESTRICT` - so an employer with a wallet and no
    // transactions was classified `purge` and then failed. Reachable whenever
    // `EMPLOYER_REGISTRATION_BONUS_COINS` is 0, which the environment schema deliberately
    // allows as a pricing decision; under the default bonus every wallet has a row and the
    // two questions happen to agree, which is why it would have stayed hidden.
    const adminUserId = await newUser('admin');
    const employerUserId = await newUser('employer');

    await db
      .insertInto('employer_wallets')
      .values({ user_id: employerUserId, balance_coins: 0 })
      .execute();

    await requestDeletion(employerUserId);

    const planned = (await retention.due()).accounts.find(
      (account) => account.userId === employerUserId,
    );
    // Anonymize, with nothing in the ledger to point at.
    expect(planned).toMatchObject({
      action: 'anonymize',
      walletRows: 0,
      paymentOrders: 0,
    });

    const outcome = await retention.purge(adminUserId);
    expect(outcome.anonymized).toContain(employerUserId);
    expect(outcome.failed).toEqual([]);

    const after = await db
      .selectFrom('users')
      .select(['phone', 'purged_at'])
      .where('id', '=', employerUserId)
      .executeTakeFirstOrThrow();
    expect(after.phone).toBeNull();
    expect(after.purged_at).toBeInstanceOf(Date);
  });

  it('counts the Payment Orders it is keeping (§6.7, M13)', async () => {
    const adminUserId = await newUser('admin');
    const employerUserId = await newUser('employer');

    await db
      .insertInto('employer_wallets')
      .values({ user_id: employerUserId, balance_coins: 0 })
      .execute();
    await db
      .insertInto('payment_orders')
      .values({
        employer_user_id: employerUserId,
        provider: 'payme',
        coins: 10,
        coin_price_uzs: '10000',
        amount_uzs: '100000',
      })
      .execute();

    await requestDeletion(employerUserId);

    const planned = (await retention.due()).accounts.find(
      (account) => account.userId === employerUserId,
    );
    // Reported so an administrator can see how much financial history is behind the
    // decision. The order does not change it - an order can only exist against a wallet, so
    // the wallet already settled it.
    expect(planned).toMatchObject({ action: 'anonymize', paymentOrders: 1 });

    const outcome = await retention.purge(adminUserId);
    expect(outcome.anonymized).toContain(employerUserId);
    expect(outcome.failed).toEqual([]);

    // §6.7 keeps the payment record for reconciliation, attached to an id nobody can resolve.
    expect(
      await db
        .selectFrom('payment_orders')
        .select('coins')
        .where('employer_user_id', '=', employerUserId)
        .execute(),
    ).toEqual([{ coins: 10 }]);
  });
});
