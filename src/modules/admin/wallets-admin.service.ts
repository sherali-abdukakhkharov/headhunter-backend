import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import {
  type WalletTransactionView,
  WalletService,
} from '@modules/wallet/wallet.service';

import { AUDIT_ACTIONS, AuditService } from './audit.service';

export interface AdminWalletRow {
  userId: string;
  phone: string | null;
  name: string | null;
  balanceCoins: number;
  registrationBonusAt: Date | null;
  unlockCount: number;
}

export interface AdminWalletDetail extends AdminWalletRow {
  transactions: WalletTransactionView[];
}

/**
 * §10.5's wallet and payment administration.
 *
 * Three reads and one write. The write is the interesting one: §10.5 allows a manual
 * adjustment "only with a mandatory reason", and "every adjustment is audited" - so it
 * writes a ledger row **and** an audit row, and the reason is required by a database check
 * as well as by the DTO.
 *
 * The adjustment cannot rewrite anything (BR-24): a correction to a wrong adjustment is
 * another adjustment. That is why the ledger's append-only triggers matter more here than
 * anywhere else - this is the one route in the product that can create Coins out of
 * nothing, and the trail of who did it has to survive the person who did it.
 *
 * Reads are logged for the same reason §11.1 logs access to protected data: a balance and
 * a payment history are financial records about an identifiable business.
 */
@Injectable()
export class AdminWalletsService {
  private readonly logger = new Logger(AdminWalletsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  /** Wallets, largest balance first - which is where the money and the risk both are. */
  async list(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<AdminWalletRow[]> {
    const rows = await this.db
      .selectFrom('employer_wallets as w')
      .innerJoin('users as u', 'u.id', 'w.user_id')
      .leftJoin('companies as c', 'c.employer_user_id', 'w.user_id')
      .select([
        'w.user_id as userId',
        'u.phone as phone',
        // The trading name if there is one, so a row is recognisable without a second
        // request; `employers` alone has no name for a company.
        'c.public_name as name',
        'w.balance_coins as balanceCoins',
        'w.registration_bonus_at as registrationBonusAt',
        (eb) =>
          eb
            .selectFrom('candidate_unlocks')
            .select((inner) => inner.fn.countAll<string>().as('count'))
            .whereRef('candidate_unlocks.employer_user_id', '=', 'w.user_id')
            .as('unlockCount'),
      ])
      .orderBy('w.balance_coins', 'desc')
      .orderBy('w.user_id')
      .limit(limit)
      .offset(offset)
      .execute();

    this.logger.log(
      `Administrator ${actorUserId} listed ${rows.length} wallet(s) (§11.1)`,
    );

    return rows.map((row) => ({
      userId: row.userId,
      phone: row.phone,
      name: row.name,
      balanceCoins: row.balanceCoins,
      registrationBonusAt: row.registrationBonusAt,
      unlockCount: Number(row.unlockCount ?? 0),
    }));
  }

  /** One wallet with its immutable history (§10.5's "immutable transaction history"). */
  async detail(
    actorUserId: string,
    employerUserId: string,
  ): Promise<AdminWalletDetail> {
    const found = await this.db
      .selectFrom('employer_wallets as w')
      .innerJoin('users as u', 'u.id', 'w.user_id')
      .leftJoin('companies as c', 'c.employer_user_id', 'w.user_id')
      .select([
        'w.user_id as userId',
        'u.phone as phone',
        'c.public_name as name',
        'w.balance_coins as balanceCoins',
        'w.registration_bonus_at as registrationBonusAt',
      ])
      .where('w.user_id', '=', employerUserId)
      .executeTakeFirst();

    if (!found) {
      // 404 rather than an empty wallet: an id that is not an employer with a wallet is
      // not something to invent a zero balance for.
      throw new NotFoundError('account.not_found');
    }

    const unlocks = await sql<{ count: string }>`
      SELECT count(*) AS count FROM candidate_unlocks
      WHERE employer_user_id = ${employerUserId}
    `.execute(this.db);

    this.logger.log(
      `Administrator ${actorUserId} read wallet ${employerUserId} (§11.1)`,
    );

    return {
      userId: found.userId,
      phone: found.phone,
      name: found.name,
      balanceCoins: found.balanceCoins,
      registrationBonusAt: found.registrationBonusAt,
      unlockCount: Number(unlocks.rows[0]?.count ?? 0),
      transactions: await this.wallet.transactions(employerUserId, 100, 0),
    };
  }

  /**
   * §10.5's manual adjustment: a ledger row, an audit row, and a mandatory reason.
   *
   * The ledger row comes from `WalletService` because that is where the balance
   * arithmetic and the row lock live; the audit row is written here because §10.4 owns
   * that table. They are not in one transaction, and that is a deliberate trade with a
   * stated direction: if the audit write failed, the adjustment would still have happened
   * and be visible in the ledger with its reason and actor attached, which is recoverable.
   * The reverse - an audit row for an adjustment that never happened - would be a lie.
   */
  async adjust(
    actorUserId: string,
    employerUserId: string,
    amountCoins: number,
    reason: string,
  ): Promise<WalletTransactionView> {
    const transaction = await this.wallet.adjust(
      actorUserId,
      employerUserId,
      amountCoins,
      reason,
    );

    await this.db.transaction().execute((trx) =>
      this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.walletAdjusted,
        targetType: 'user',
        targetId: employerUserId,
        reason,
        details: {
          amountCoins,
          balanceAfter: transaction.balanceAfter,
          transactionId: transaction.id,
        },
      }),
    );

    return transaction;
  }
}
