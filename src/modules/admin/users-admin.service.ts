import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { AccountStatus, UserRole } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import {
  endOfDayInZone,
  formatWithOffset,
  startOfDayInZone,
} from '@infra/time/format';

import { NotificationsService } from '@modules/notifications/notifications.service';

import { AUDIT_ACTIONS, AuditService } from './audit.service';
import { DISPLAY_NAME } from './display-name';

export interface UserSearchFilters {
  /** §10.4's "by phone" - a partial number, because that is how one is remembered. */
  phone?: string;
  name?: string;
  role?: UserRole;
  status?: AccountStatus;
  registeredFrom?: string;
  registeredTo?: string;
}

export interface AdminUserRow {
  userId: string;
  phone: string | null;
  name: string | null;
  roles: UserRole[];
  status: AccountStatus;
  restrictedUntil: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AdminUserDetail extends AdminUserRow {
  /** §10.4's "relevant moderation history" - BR-08's account trail. */
  statusHistory: {
    fromStatus: AccountStatus | null;
    toStatus: AccountStatus;
    actorRole: UserRole | null;
    reason: string | null;
    createdAt: Date;
  }[];
  /** Complaints about this user, which is the other half of "relevant". */
  complaints: { id: string; reason: string; status: string; createdAt: Date }[];
}

interface UserRow {
  id: string;
  phone: string | null;
  name: string | null;
  roles: string | null;
  status: AccountStatus;
  restricted_until: Date | null;
  created_at: Date;
  last_login_at: Date | null;
}

/**
 * §10.4's user management, and UAT-14's block enforcement.
 *
 * Two things about this service are privacy decisions rather than implementation details.
 *
 * - **An administrator sees phone numbers**, and BR-09 says so: `expose()` returns
 *   `contactDetails: true` with reason `admin`, because §10.4 requires finding users by
 *   phone and §10.2 requires reviewing reports about them. The rule is not bypassed here -
 *   it is the branch the rule already has, and §11.1's logging requirement is why every
 *   search and every read is logged.
 * - **Every status change carries a mandatory reason** (§10.4) and writes both an
 *   `account_status_history` row (BR-08) and an audit row, in one transaction. A warning
 *   changes no status, so for a warning the audit row is the whole record - which is
 *   exactly why the audit log has to exist rather than being derivable from the history
 *   tables.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * §10.4's search: "by phone, name, role, status, or registration date".
   *
   * The name is looked for in every place a user can have one - a candidate's profile, an
   * individual employer's own name, a company's public and legal name, and the account's own
   * `full_name` for the administrators who have no profile at all - because an administrator
   * searching for "Uzum" should not have to know which kind of account it is, and one
   * searching for a colleague should not come up empty because the colleague never applied
   * for a job. It is a prefix-insensitive `ILIKE`, and that is acceptable here for the reason it
   * was *not* acceptable for §7.1's specialization filter: this is one administrator
   * looking for one account they already know of, not a matching rule two users have to
   * agree on across four interface variants.
   */
  async search(
    actorUserId: string,
    filters: UserSearchFilters,
    limit: number,
    offset: number,
  ): Promise<AdminUserRow[]> {
    const conditions = [sql`true`];

    if (filters.phone) {
      conditions.push(sql`u.phone LIKE ${`%${filters.phone}%`}`);
    }

    if (filters.name) {
      const pattern = `%${filters.name}%`;
      conditions.push(sql`(
        cp.full_name ILIKE ${pattern}
        OR e.full_name ILIKE ${pattern}
        OR c.public_name ILIKE ${pattern}
        OR c.legal_name ILIKE ${pattern}
        OR u.full_name ILIKE ${pattern}
      )`);
    }

    if (filters.role) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.user_id = u.id AND ur.role = ${filters.role}::user_role
      )`);
    }

    if (filters.status) {
      conditions.push(sql`u.status = ${filters.status}::account_status`);
    }

    // Both bounds are inclusive calendar dates in the platform zone, resolved to instants
    // here rather than cast in SQL - `created_at >= '2026-08-01'::date` resolves the cast
    // in the session zone (UTC on this deployment), so it would mean 05:00 Tashkent and
    // file a 02:00 registration under the previous day.
    if (filters.registeredFrom) {
      const start = startOfDayInZone(filters.registeredFrom, this.timeZone);
      conditions.push(sql`u.created_at >= ${start}`);
    }

    if (filters.registeredTo) {
      const end = endOfDayInZone(filters.registeredTo, this.timeZone);
      conditions.push(sql`u.created_at < ${end}`);
    }

    const result = await sql<UserRow>`
      SELECT u.id, u.phone, u.status, u.restricted_until, u.created_at, u.last_login_at,
        ${DISPLAY_NAME} AS name,
        (
          SELECT string_agg(ur.role::text, ',' ORDER BY ur.role)
          FROM user_roles ur WHERE ur.user_id = u.id
        ) AS roles
      FROM users u
      LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
      LEFT JOIN employers e ON e.user_id = u.id
      LEFT JOIN companies c ON c.employer_user_id = u.id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `.execute(this.db);

    // §11.1: sensitive access is logged, and a search that returns phone numbers is
    // sensitive access however ordinary it looks.
    this.logger.log(
      `Admin ${actorUserId} searched users (${JSON.stringify(filters)}): ${result.rows.length} rows`,
    );

    return result.rows.map(toUserRow);
  }

  /** One user, with §10.4's "account status and relevant moderation history". */
  async detail(actorUserId: string, userId: string): Promise<AdminUserDetail> {
    const result = await sql<UserRow>`
      SELECT u.id, u.phone, u.status, u.restricted_until, u.created_at, u.last_login_at,
        ${DISPLAY_NAME} AS name,
        (
          SELECT string_agg(ur.role::text, ',' ORDER BY ur.role)
          FROM user_roles ur WHERE ur.user_id = u.id
        ) AS roles
      FROM users u
      LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
      LEFT JOIN employers e ON e.user_id = u.id
      LEFT JOIN companies c ON c.employer_user_id = u.id
      WHERE u.id = ${userId}
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundError('user.not_found');
    }

    const [history, complaints] = await Promise.all([
      this.db
        .selectFrom('account_status_history')
        .select([
          'from_status',
          'to_status',
          'actor_role',
          'reason',
          'created_at',
        ])
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .execute(),
      this.db
        .selectFrom('complaints')
        .select(['id', 'reason', 'status', 'created_at'])
        .where('target_id', '=', userId)
        .where('target_type', 'in', ['user', 'profile'])
        .orderBy('created_at', 'desc')
        .execute(),
    ]);

    this.logger.log(`Admin ${actorUserId} viewed user ${userId}`);

    return {
      ...toUserRow(row),
      statusHistory: history.map((entry) => ({
        fromStatus: entry.from_status,
        toStatus: entry.to_status,
        actorRole: entry.actor_role,
        reason: entry.reason,
        createdAt: entry.created_at,
      })),
      complaints: complaints.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        status: entry.status,
        createdAt: entry.created_at,
      })),
    };
  }

  /**
   * §10.4's warning: a record and (with M9) a notification, and **no status change**.
   *
   * The audit log is the whole record of it, which is the clearest answer to "why does an
   * audit log exist when six tables already record status changes": this action changes no
   * status.
   */
  async warn(
    actorUserId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    assertReason(reason);
    await this.assertExists(userId);

    await this.db.transaction().execute((trx) =>
      this.audit.record(trx, {
        actorUserId,
        action: AUDIT_ACTIONS.userWarned,
        targetType: 'user',
        targetId: userId,
        reason,
      }),
    );

    // §9.2 row 9: "Administrative restriction or complaint decision → Affected user".
    // A warning that the person is never told about is not a warning.
    await this.notifications.notify({
      userId,
      event: 'account_action',
      target: { type: 'user', id: userId },
    });
  }

  /**
   * §10.4's restrict, block and unblock, with their mandatory reason.
   *
   * One method for the three, because they differ only in the status they set: the
   * `account_status_history` row (BR-08) and the audit row are identical work, and
   * splitting them is how one of the three ends up without one of the two.
   *
   * `restrictedUntil` is what makes §10.4's restriction *temporary*; `AccountStatusGuard`
   * lifts it when the date passes.
   */
  async changeStatus(
    actorUserId: string,
    userId: string,
    to: Extract<AccountStatus, 'active' | 'restricted' | 'blocked'>,
    reason: string,
    restrictedUntil: Date | null = null,
  ): Promise<void> {
    assertReason(reason);

    if (actorUserId === userId) {
      // An administrator blocking themselves would lock the platform's only admin out of
      // it, and there is no route to undo it from the outside.
      throw new ForbiddenError('admin.cannot_target_self');
    }

    const outcome = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('users')
        .select('status')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();

      if (!current) {
        return { error: 'user.not_found' } as const;
      }

      if (current.status === to) {
        return { error: 'admin.status_unchanged' } as const;
      }

      // A deletion request is not an administrator's to override: BR-14 owns that state,
      // and a block that overwrote it would lose the request.
      if (current.status === 'deletion_requested') {
        return { error: 'admin.status_unchanged' } as const;
      }

      await trx
        .updateTable('users')
        .set({
          status: to,
          restricted_until: to === 'restricted' ? restrictedUntil : null,
          updated_at: sql`now()`,
        })
        .where('id', '=', userId)
        .execute();

      await trx
        .insertInto('account_status_history')
        .values({
          user_id: userId,
          from_status: current.status,
          to_status: to,
          actor_user_id: actorUserId,
          actor_role: 'admin',
          reason,
        })
        .execute();

      await this.audit.record(trx, {
        actorUserId,
        action:
          to === 'blocked'
            ? AUDIT_ACTIONS.userBlocked
            : to === 'restricted'
              ? AUDIT_ACTIONS.userRestricted
              : AUDIT_ACTIONS.userUnblocked,
        targetType: 'user',
        targetId: userId,
        reason,
        details: {
          from: current.status,
          to,
          // §2 applies here too, and this is the one place it is easy to miss: the audit
          // `details` bag is stored as jsonb and handed back to `GET /admin/audit`
          // verbatim, so nothing downstream can tell a timestamp from any other string
          // and reformat it on the way out. `toISOString()` would put a `Z` in a response.
          ...(restrictedUntil
            ? {
                restrictedUntil: formatWithOffset(
                  restrictedUntil,
                  this.timeZone,
                ),
              }
            : {}),
        },
      });

      return { ok: true } as const;
    });

    if ('error' in outcome) {
      if (outcome.error === 'user.not_found') {
        throw new NotFoundError('user.not_found');
      }

      throw new ConflictError('admin.status_unchanged');
    }

    // §9.2 row 9 again. An `account` notice, so it reaches them whatever their
    // preferences say - being restricted is exactly the thing a user must not be able to
    // mute.
    await this.notifications.notify({
      userId,
      event: 'account_action',
      target: { type: 'user', id: userId },
    });
  }

  private async assertExists(userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('user.not_found');
    }
  }
}

function assertReason(reason: string): void {
  // §10.4: "with a reason", for all four actions. Enforced here rather than by a DTO
  // rule, so the requirement holds for every caller of the service.
  if (!reason.trim()) {
    throw new ForbiddenError('admin.reason_required');
  }
}

function toUserRow(row: UserRow): AdminUserRow {
  return {
    userId: row.id,
    phone: row.phone,
    name: row.name,
    roles: row.roles ? (row.roles.split(',') as UserRole[]) : [],
    status: row.status,
    restrictedUntil: row.restricted_until,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}
