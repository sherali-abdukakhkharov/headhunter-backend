import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';

import { ForbiddenError } from '../exceptions/localized.exception';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/**
 * Methods that change state, and therefore fall under BR-10.
 *
 * Exported so `api-surface.spec.ts` can assert the property that actually matters: **every
 * mutating route in the product uses a method in this set.** The guard is global, so the risk
 * was never a route without it - it is a route whose method this set does not recognise, which
 * would drop out of BR-10 silently.
 */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * BR-10: a blocked or restricted account is refused every mutation.
 *
 * Registered globally and applied by HTTP method rather than per module, because
 * §13.1 UAT-14 requires this to hold for vacancies, applications, invitations
 * *and* messages. Enforcing it per module means each new module is a chance to
 * forget, and retrofitting it later means auditing every endpoint.
 *
 * This is the one check that deliberately hits the database on every request:
 * blocking a user has to take effect immediately, not when their access token
 * happens to expire. Reads stay open so a blocked user can still see why - and
 * `restricted` is a narrower state than `blocked`, but §10.2 gives it the same
 * mutation ban.
 */
@Injectable()
export class AccountStatusGuard implements CanActivate {
  private readonly logger = new Logger(AccountStatusGuard.name);

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // Unauthenticated routes have nothing to check; AuthorizationGuard already
    // decided whether that is allowed.
    if (!user || !MUTATING_METHODS.has(request.method)) {
      return true;
    }

    const row = await this.db
      .selectFrom('users')
      .select(['status', 'restricted_until'])
      .where('id', '=', user.id)
      .executeTakeFirst();

    if (!row) {
      throw new ForbiddenError('account.gone');
    }

    if (row.status === 'blocked') {
      throw new ForbiddenError('account.blocked_action');
    }

    if (row.status === 'restricted') {
      // §10.4 asks for a *temporary* restriction, and this is where "temporary" is
      // realized: the row is already loaded, so noticing that the end date has passed
      // costs nothing, and the restriction is lifted here rather than by a scheduled job
      // this deployment has no scheduler for. The lift writes its BR-08 history row.
      if (!(await this.expireRestriction(user.id))) {
        throw new ForbiddenError('account.restricted_action');
      }
    }

    return true;
  }

  /**
   * Lifts a restriction whose end date has passed, and reports whether it did.
   *
   * The `WHERE` clause carries the whole condition, so two concurrent requests cannot both
   * write the history row: the second updates nothing and reads `numUpdatedRows` of zero.
   * It then re-reads the status, because "I did not lift it" and "it was not expired" are
   * different answers and only the second is a refusal.
   */
  private async expireRestriction(userId: string): Promise<boolean> {
    const lifted = await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('users')
        .set({
          status: 'active',
          restricted_until: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', userId)
        .where('status', '=', 'restricted')
        .where('restricted_until', 'is not', null)
        .where(sql<boolean>`restricted_until <= now()`)
        .executeTakeFirst();

      if (result.numUpdatedRows === 0n) {
        return false;
      }

      // BR-08: no status change without its history row. A null actor is honest - nobody
      // decided this, the clock did.
      await trx
        .insertInto('account_status_history')
        .values({
          user_id: userId,
          from_status: 'restricted',
          to_status: 'active',
          actor_user_id: null,
          actor_role: null,
          reason: 'restriction_expired',
        })
        .execute();

      return true;
    });

    if (lifted) {
      this.logger.log(`Restriction on user ${userId} expired and was lifted`);
    }

    return lifted;
  }
}
