import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import type { UserRole } from '@infra/db/database.types';

/** Authenticated caller, put on the request by `AuthorizationGuard`. */
export interface CurrentUser {
  id: string;
  roles: UserRole[];
  activeRole: UserRole | null;
  sessionId: string;
}

/** Express request once `AuthorizationGuard` has run. */
export interface AuthenticatedRequest extends Request {
  user?: CurrentUser;
}

/**
 * Injects the authenticated caller.
 *
 * Throws nothing when absent - a route reaching a handler without a user means
 * the guard was not applied, which is a wiring bug rather than a request error.
 * The type is non-optional so that bug surfaces at the first property access
 * instead of being silently swallowed by optional chaining.
 */
export const ActiveUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user as CurrentUser;
  },
);
