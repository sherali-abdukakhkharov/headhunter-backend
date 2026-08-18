import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import {
  RETENTION_POLICY,
  type RetentionRule,
  provisionalRules,
  retentionCutoff,
} from '@infra/retention/retention-policy';

import { AUDIT_ACTIONS, AuditService } from './audit.service';

/** One account the grace period has run out for, and what the purge would do to it. */
export interface DueAccount {
  userId: string;
  requestedAt: Date;
  /** `anonymize` when a record has to outlive the person - see below. */
  action: 'purge' | 'anonymize';
  /** How many audit rows depend on this account's id surviving. */
  auditRows: number;
  /** How many wallet transactions do. Financial history outlives the account (BR-24). */
  walletRows: number;
  /** And how many Payment Orders, which §6.7 keeps for reconciliation (M13). */
  paymentOrders: number;
}

export interface RetentionDue {
  accounts: DueAccount[];
  /** Rows a sweep would remove, per rule code. */
  transient: { code: string; rows: number }[];
  /** Periods no lawyer has confirmed, repeated here so a caller cannot miss them. */
  provisional: string[];
}

export interface RetentionOutcome {
  purged: string[];
  anonymized: string[];
  failed: { userId: string; error: string }[];
  transient: { code: string; rows: number }[];
}

/**
 * BR-14's purge (§4.2 "retention handling according to the approved privacy policy").
 *
 * The periods are not decided here - they are declared in
 * `infra/retention/retention-policy.ts` with a provenance tag, so the client's answer is
 * an edit to that table. This service is the mechanism.
 *
 * **Nothing runs on a timer.** An administrator asks what is due, sees it, and triggers the
 * purge; every account removed writes an audit row. That is a deliberate choice over a
 * scheduler: the periods are still provisional, and a wrong number that needs a person to
 * act on it cannot quietly destroy a year of work histories overnight.
 *
 * Two things about the implementation are not obvious and cost a debugging session each.
 *
 * **A plain `DELETE FROM users` fails.** Sixteen foreign keys cascade from `users`, but
 * three tables hold `ON DELETE RESTRICT` references to `stored_files` - a company logo, a
 * verification submission's evidence, and a message's attachment - and the cascade reaches
 * the files before those rows release them. So the purge clears the referencing rows in
 * an explicit order first. This was found by trying it, not by reading the schema.
 *
 * **An administrator cannot be deleted at all**, by design: `admin_audit_log.actor_user_id`
 * is `RESTRICT`, because an audit row that forgot who acted is not an audit row (§10.4).
 * Those accounts are *anonymized* instead - the phone, Telegram identity and login history
 * go, the row and its id stay - which satisfies the erasure duty and the accountability
 * duty at once. `users_purged_has_no_credential` makes "purged but still holding a phone
 * number" unrepresentable rather than merely unwritten.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The declared policy, verbatim, for `GET /admin/retention/policy`. */
  policy(): readonly RetentionRule[] {
    return RETENTION_POLICY;
  }

  /** What a purge would do right now, without doing any of it. */
  async due(now: Date = new Date()): Promise<RetentionDue> {
    const accounts = await this.dueAccounts(now);
    const transient = await this.transientCounts(now);

    return {
      accounts,
      transient,
      provisional: provisionalRules().map((rule) => rule.code),
    };
  }

  /**
   * Purges everything due, one account per transaction.
   *
   * Per account rather than one big transaction: a single account that cannot be purged -
   * a reference nothing predicted - must not roll back the twenty that could. The failure
   * is reported, not thrown, for the same reason.
   */
  async purge(
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<RetentionOutcome> {
    const outcome: RetentionOutcome = {
      purged: [],
      anonymized: [],
      failed: [],
      transient: [],
    };

    for (const account of await this.dueAccounts(now)) {
      try {
        await this.purgeAccount(account, actorUserId, now);

        if (account.action === 'purge') {
          outcome.purged.push(account.userId);
        } else {
          outcome.anonymized.push(account.userId);
        }
      } catch (error: unknown) {
        // Reported rather than thrown: see the method comment.
        outcome.failed.push({
          userId: account.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.error(
          `retention: could not purge ${account.userId}: ${String(error)}`,
        );
      }
    }

    outcome.transient = await this.sweepTransient(now);

    this.logger.log(
      `retention: purged ${outcome.purged.length}, anonymized ${outcome.anonymized.length}, ` +
        `failed ${outcome.failed.length}`,
    );

    return outcome;
  }

  /** Accounts whose grace period has run out and which have not been dealt with. */
  private async dueAccounts(now: Date): Promise<DueAccount[]> {
    const cutoff = retentionCutoff('account_personal_data', now);

    if (!cutoff) {
      return [];
    }

    const rows = await this.db
      .selectFrom('deletion_requests as d')
      .innerJoin('users as u', 'u.id', 'd.user_id')
      .select([
        'd.user_id as userId',
        'd.requested_at as requestedAt',
        (eb) =>
          eb
            .selectFrom('admin_audit_log as a')
            .select((inner) => inner.fn.countAll<string>().as('count'))
            .whereRef('a.actor_user_id', '=', 'd.user_id')
            .as('auditRows'),
        // A wallet is the second reason a row cannot be deleted, and it was found by a
        // test rather than by reading the schema: `employer_wallets` cascades to an
        // append-only ledger, so the delete failed inside the cascade.
        (eb) =>
          eb
            .selectFrom('wallet_transactions as w')
            .select((inner) => inner.fn.countAll<string>().as('count'))
            .whereRef('w.employer_user_id', '=', 'd.user_id')
            .as('walletRows'),
        // **The wallet row itself, which is the thing the constraint actually protects.**
        // Counting ledger rows is not the same question: `employer_wallets.user_id` is
        // `ON DELETE RESTRICT`, so a wallet with *no* transactions still refuses the delete -
        // reachable whenever `EMPLOYER_REGISTRATION_BONUS_COINS` is 0, which the environment
        // schema deliberately allows as a pricing decision. Under the default bonus every
        // wallet has at least one row and the two agree, which is exactly why this would have
        // stayed hidden until an instance turned the bonus off.
        (eb) =>
          eb
            .selectFrom('employer_wallets as ew')
            .select((inner) => inner.fn.countAll<string>().as('count'))
            .whereRef('ew.user_id', '=', 'd.user_id')
            .as('walletRow'),
        // M13's payment records, for the report rather than for the decision: an order can
        // only exist against a wallet, so `walletRow` already covers the constraint. §6.7
        // requires these kept for reconciliation, and an administrator deciding to anonymize
        // an account should see how much financial history is behind it.
        (eb) =>
          eb
            .selectFrom('payment_orders as po')
            .select((inner) => inner.fn.countAll<string>().as('count'))
            .whereRef('po.employer_user_id', '=', 'd.user_id')
            .as('paymentOrders'),
      ])
      .where('d.cancelled_at', 'is', null)
      .where('d.requested_at', '<', cutoff)
      // Already purged: the row survives only because it is an audit actor.
      .where('u.purged_at', 'is', null)
      .orderBy('d.requested_at')
      .execute();

    return rows.map((row) => {
      const auditRows = Number(row.auditRows ?? 0);
      const walletRows = Number(row.walletRows ?? 0);
      const paymentOrders = Number(row.paymentOrders ?? 0);
      const hasWallet = Number(row.walletRow ?? 0) > 0;

      return {
        userId: row.userId,
        requestedAt: row.requestedAt,
        // Either kind of record keeps the row alive. Both are append-only by design, and
        // neither can be rewritten to forget who it belonged to - so the person is erased
        // and the id survives. The decision is made on what the **constraints** refuse, not
        // on how much history there is: an audit row (`RESTRICT` on the actor) or a wallet
        // row (`RESTRICT` on the owner).
        action:
          auditRows > 0 || hasWallet
            ? ('anonymize' as const)
            : ('purge' as const),
        auditRows,
        walletRows,
        paymentOrders,
      };
    });
  }

  /**
   * One account, in one transaction.
   *
   * The order of the first four statements is the whole trick: they release the three
   * `RESTRICT` references to `stored_files` before the files themselves go, and the files
   * before the row that cascades to them.
   */
  private async purgeAccount(
    account: DueAccount,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // 1. A company logo points at a file this user owns.
      await trx
        .updateTable('companies')
        .set({ logo_file_id: null })
        .where('employer_user_id', '=', account.userId)
        .execute();

      // 2. Verification evidence. Deleting the submission cascades to the join rows that
      //    hold the RESTRICT reference; the files themselves go in step 4.
      await trx
        .deleteFrom('verification_submissions')
        .where('employer_user_id', '=', account.userId)
        .execute();

      // 3. Messages this user sent, which may carry an attachment they own. These would
      //    cascade with the user anyway - the point is that they go *first*.
      await trx
        .deleteFrom('messages')
        .where('sender_user_id', '=', account.userId)
        .execute();

      // 4. The files. Only the metadata: the bytes live in a Telegram chat, and there is
      //    no delete in the Bot API worth trusting for this (ARCHITECTURE.md §9) - which
      //    is stated in docs/RETENTION.md rather than hidden here.
      await trx
        .deleteFrom('stored_files')
        .where('owner_user_id', '=', account.userId)
        .execute();

      if (account.action === 'purge') {
        // Sixteen cascades take the profile, applications, messages, notifications,
        // sessions and history with the row.
        await trx
          .deleteFrom('users')
          .where('id', '=', account.userId)
          .execute();
      } else {
        // The actor survives; the person does not. `users_purged_has_no_credential`
        // refuses this write if it leaves a credential behind.
        await trx
          .updateTable('users')
          .set({
            phone: null,
            telegram_user_id: null,
            telegram_username: null,
            last_login_at: null,
            purged_at: now,
            updated_at: now,
          })
          .where('id', '=', account.userId)
          .execute();

        // Their own data still goes, and the admin role with it: an account nobody can
        // sign into must not remain a live administrator.
        await trx
          .deleteFrom('candidate_profiles')
          .where('user_id', '=', account.userId)
          .execute();
        await trx
          .deleteFrom('employers')
          .where('user_id', '=', account.userId)
          .execute();
        await trx
          .deleteFrom('sessions')
          .where('user_id', '=', account.userId)
          .execute();
        await trx
          .deleteFrom('user_roles')
          .where('user_id', '=', account.userId)
          .execute();
        await trx
          .deleteFrom('device_tokens')
          .where('user_id', '=', account.userId)
          .execute();
      }

      // In the same transaction as the erasure, and `target_id` is a bare uuid rather
      // than a foreign key - which is what lets an audit row name an account that no
      // longer exists.
      await this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.accountPurged,
        targetType: 'user',
        targetId: account.userId,
        reason:
          account.action === 'anonymize'
            ? `BR-14: identity erased, id retained for ${account.auditRows} audit ` +
              `row(s), ${account.walletRows} wallet transaction(s) and ` +
              `${account.paymentOrders} payment order(s)`
            : 'BR-14: account and personal data deleted',
        details: {
          action: account.action,
          auditRows: account.auditRows,
          walletRows: account.walletRows,
          paymentOrders: account.paymentOrders,
        },
      });
    });
  }

  /** How many rows each transient rule would remove, for the preview. */
  private async transientCounts(
    now: Date,
  ): Promise<{ code: string; rows: number }[]> {
    const counts: { code: string; rows: number }[] = [];

    for (const [code, count] of [
      ['otp_codes', () => this.countOtp(now)],
      ['sessions', () => this.countSessions(now)],
      ['rate_limit_counters', () => this.countRateLimits(now)],
      ['idempotency_keys', () => this.countIdempotency(now)],
      ['notifications', () => this.countNotifications(now)],
    ] as const) {
      counts.push({ code, rows: await count() });
    }

    return counts;
  }

  /** The sweeps themselves. Each is one statement, and each reports what it removed. */
  private async sweepTransient(
    now: Date,
  ): Promise<{ code: string; rows: number }[]> {
    const swept: { code: string; rows: number }[] = [];

    const otp = retentionCutoff('otp_codes', now);
    if (otp) {
      const result = await this.db
        .deleteFrom('otp_codes')
        .where('created_at', '<', otp)
        .executeTakeFirst();
      swept.push({ code: 'otp_codes', rows: Number(result.numDeletedRows) });
    }

    const sessions = retentionCutoff('sessions', now);
    if (sessions) {
      // Expired *or* revoked, and only once it is well past the point where reuse
      // detection could still need it (§4.2).
      const result = await this.db
        .deleteFrom('sessions')
        .where((eb) =>
          eb.or([
            eb('expires_at', '<', sessions),
            eb('revoked_at', '<', sessions),
          ]),
        )
        .executeTakeFirst();
      swept.push({ code: 'sessions', rows: Number(result.numDeletedRows) });
    }

    const limits = retentionCutoff('rate_limit_counters', now);
    if (limits) {
      const result = await this.db
        .deleteFrom('rate_limit_counters')
        .where('window_start', '<', limits)
        .executeTakeFirst();
      swept.push({
        code: 'rate_limit_counters',
        rows: Number(result.numDeletedRows),
      });
    }

    const keys = retentionCutoff('idempotency_keys', now);
    if (keys) {
      const result = await this.db
        .deleteFrom('idempotency_keys')
        .where('created_at', '<', keys)
        .executeTakeFirst();
      swept.push({
        code: 'idempotency_keys',
        rows: Number(result.numDeletedRows),
      });
    }

    const notifications = retentionCutoff('notifications', now);
    if (notifications) {
      const result = await this.db
        .deleteFrom('notifications')
        .where('created_at', '<', notifications)
        .executeTakeFirst();
      swept.push({
        code: 'notifications',
        rows: Number(result.numDeletedRows),
      });
    }

    return swept;
  }

  private async countOtp(now: Date): Promise<number> {
    const cutoff = retentionCutoff('otp_codes', now);

    return cutoff
      ? this.count(
          sql`SELECT count(*) FROM otp_codes WHERE created_at < ${cutoff}`,
        )
      : 0;
  }

  private async countSessions(now: Date): Promise<number> {
    const cutoff = retentionCutoff('sessions', now);

    return cutoff
      ? this.count(
          sql`SELECT count(*) FROM sessions
              WHERE expires_at < ${cutoff} OR revoked_at < ${cutoff}`,
        )
      : 0;
  }

  private async countRateLimits(now: Date): Promise<number> {
    const cutoff = retentionCutoff('rate_limit_counters', now);

    return cutoff
      ? this.count(
          sql`SELECT count(*) FROM rate_limit_counters WHERE window_start < ${cutoff}`,
        )
      : 0;
  }

  private async countIdempotency(now: Date): Promise<number> {
    const cutoff = retentionCutoff('idempotency_keys', now);

    return cutoff
      ? this.count(
          sql`SELECT count(*) FROM idempotency_keys WHERE created_at < ${cutoff}`,
        )
      : 0;
  }

  private async countNotifications(now: Date): Promise<number> {
    const cutoff = retentionCutoff('notifications', now);

    return cutoff
      ? this.count(
          sql`SELECT count(*) FROM notifications WHERE created_at < ${cutoff}`,
        )
      : 0;
  }

  private async count(
    query: ReturnType<typeof sql<{ count: string }>>,
  ): Promise<number> {
    const result = await query.execute(this.db);

    return Number(
      (result.rows[0] as { count?: string } | undefined)?.count ?? 0,
    );
  }
}
