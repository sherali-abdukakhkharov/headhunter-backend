import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { type Database, KYSELY } from '@infra/db/database.module';

import { ForbiddenError } from '../exceptions/localized.exception';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/** Methods that change state, and therefore fall under BR-10. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
      .select('status')
      .where('id', '=', user.id)
      .executeTakeFirst();

    if (!row) {
      throw new ForbiddenError('account.gone');
    }

    if (row.status === 'blocked') {
      throw new ForbiddenError('account.blocked_action');
    }

    if (row.status === 'restricted') {
      throw new ForbiddenError('account.restricted_action');
    }

    return true;
  }
}
