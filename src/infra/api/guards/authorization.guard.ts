import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SessionService } from '@modules/auth/session.service';
import { TokenService } from '@modules/auth/token.service';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/**
 * Authenticates a bearer access token and populates `request.user`.
 *
 * Registered globally, so a new route is protected by default and opening one up
 * is an explicit `@Public()`. The alternative - opt-in protection - means every
 * forgotten decorator is an unauthenticated endpoint, and that mistake is
 * invisible in review.
 *
 * Runs before `RoleGuard` and `AccountStatusGuard`, both of which read the user
 * it sets.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Authorization token is required');
    }

    const claims = await this.tokens.verifyAccessToken(token);

    // The session is checked on every request rather than trusted for the access
    // token's lifetime. Otherwise "terminate all sessions" (§4.2) would leave a
    // revoked device working for up to the full access-token TTL, which is not
    // what a user pressing that button believes it means.
    if (!(await this.sessions.isActive(claims.sid))) {
      throw new UnauthorizedException('Session has been revoked');
    }

    request.user = {
      id: claims.sub,
      roles: claims.roles,
      activeRole: claims.activeRole,
      sessionId: claims.sid,
    };

    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');

  // Only `Bearer` is accepted. Falling back to the raw header value would let a
  // malformed client send credentials in a shape we never intended to support.
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
