import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '@infra/db/database.types';

import {
  ForbiddenError,
  UnauthorizedError,
} from '../exceptions/localized.exception';
import { REQUIRED_ROLES_KEY } from '../decorators/require-role.decorator';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/**
 * Enforces `@RequireRole` against the caller's **active** role.
 *
 * Reads the role from the token claims rather than the database: the claim was
 * only ever issued after `AuthService.switchActiveRole` verified the grant in
 * Postgres, so re-reading it here would add a query per request without
 * tightening anything. Revoking a role therefore takes effect at the next
 * refresh, at most one access-token TTL later - acceptable for roles, and
 * explicitly not how account blocking works (see `AccountStatusGuard`).
 *
 * Routes without the decorator pass through.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedError('error.unauthorized');
    }

    if (!user.activeRole) {
      // A multi-role account that has not chosen yet. Distinguished from a plain
      // 403 because the client's fix is different: select a role, not give up.
      throw new ForbiddenError('role.none_active');
    }

    if (!required.includes(user.activeRole)) {
      throw new ForbiddenError('role.not_allowed', {
        roles: required.join(', '),
      });
    }

    return true;
  }
}
