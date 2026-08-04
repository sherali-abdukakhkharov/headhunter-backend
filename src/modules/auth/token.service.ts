import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { UserRole } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';

/**
 * Claims carried by an access token.
 *
 * `roles` is every role the account holds and `activeRole` is the one the client
 * is currently acting as (§2.3, ARCHITECTURE.md §8). Both are needed: the guard
 * enforces `activeRole`, and the server must be able to check that a requested
 * switch targets a role actually granted - without a second query on every
 * switch.
 */
export interface AccessTokenClaims {
  sub: string;
  roles: UserRole[];
  activeRole: UserRole | null;
  /** Session id, so a revoked session can be rejected before any handler runs. */
  sid: string;
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.secret = config.get('JWT_SECRET', { infer: true });
    this.accessTtlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', {
      infer: true,
    });
  }

  /** Seconds until an issued access token expires - returned to the client. */
  get expiresInSeconds(): number {
    return this.accessTtlSeconds;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.secret,
      expiresIn: this.accessTtlSeconds,
      algorithm: 'HS256',
    });
  }

  /**
   * Verifies an access token and returns its claims.
   *
   * `algorithms` is pinned: without it a token signed with `alg: none` or a
   * different algorithm than intended can be accepted.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.secret,
        algorithms: ['HS256'],
      });
    } catch {
      // Deliberately not echoing the underlying reason: "expired" versus
      // "signature invalid" is useful to an attacker and useless to a client
      // that must refresh either way.
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
