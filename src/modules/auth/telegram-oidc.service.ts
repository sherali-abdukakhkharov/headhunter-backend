import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';

import { UnauthorizedError } from '@infra/api/exceptions/localized.exception';
import type { AppEnv } from '@infra/env-schema';

/**
 * Verifies a Telegram-issued OpenID Connect `id_token`.
 *
 * ## The flow this sits at the end of
 *
 * 1. The Flutter app calls the official Telegram Login SDK, which opens the
 *    Telegram app (or a web sheet when Telegram is not installed) against
 *    `https://oauth.telegram.org/auth` with our bot id as `client_id`.
 * 2. The user approves the requested scopes in Telegram itself.
 * 3. The SDK completes the OAuth2 authorization-code exchange with PKCE and hands
 *    the app a signed `id_token`.
 * 4. The app posts that token here. **This is the only place it is trusted**, and
 *    only after the checks below.
 *
 * ## Why an id_token from the client is safe to accept
 *
 * The same shape as Google or Apple sign-in on mobile. The token is signed by
 * Telegram with RS256 and its `aud` claim is our bot id, so it can only have been
 * produced by an authorization for *our* bot. A token minted for any other
 * application fails the audience check, which is what makes the pattern sound
 * rather than merely convenient.
 *
 * Four checks, all of which must pass:
 *
 * - **Signature**, against Telegram's published JWKS. `jose` selects the key by
 *   `kid` and refetches on rotation, which is the part worth not hand-rolling.
 * - **Issuer** is exactly `https://oauth.telegram.org`.
 * - **Audience** is our bot id.
 * - **Age.** `maxTokenAge` bounds `iat`, so a token captured somewhere and replayed
 *   later is refused even while `exp` is still in the future. This is the practical
 *   replay defence available to us: OIDC's `nonce` is the stronger one, but binding
 *   it requires the client SDK to accept a server-issued nonce, which the current
 *   Flutter package does not expose. If that changes, add the nonce here - the
 *   claim is verified below when present.
 */

/** The claims we rely on, from the `openid`, `profile` and `phone` scopes. */
export interface TelegramIdentity {
  /** Telegram user id. The credential; stable, and always present. */
  telegramUserId: string;
  /** `@username` without the `@`. Optional on Telegram and user-changeable. */
  username: string | null;
  /** From the `phone` scope, and only when Telegram reports it verified. */
  verifiedPhone: string | null;
  displayName: string | null;
}

@Injectable()
export class TelegramOidcService {
  private readonly logger = new Logger(TelegramOidcService.name);

  private readonly issuer: string;
  private readonly audience: string;
  private readonly maxTokenAgeSeconds: number;
  private readonly requirePhone: boolean;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<AppEnv, true>) {
    this.issuer = config.get('TELEGRAM_OIDC_ISSUER', { infer: true });
    this.audience = config.get('TELEGRAM_LOGIN_BOT_ID', { infer: true });
    this.maxTokenAgeSeconds = config.get('TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS', {
      infer: true,
    });
    this.requirePhone = config.get('TELEGRAM_REQUIRE_PHONE', { infer: true });

    // Built once: the key set is cached across requests and refetched only on an
    // unknown `kid`, with a cooldown so a token carrying a bogus kid cannot be used
    // to hammer Telegram's endpoint.
    this.jwks = createRemoteJWKSet(
      new URL(config.get('TELEGRAM_JWKS_URL', { infer: true })),
      { cacheMaxAge: 600_000, cooldownDuration: 30_000 },
    );
  }

  /**
   * Verifies a token and returns the identity it asserts.
   *
   * Every failure is the same `UnauthorizedError` to the client. The specific
   * reason is logged: telling a caller whether a token was expired, misaddressed or
   * unsigned describes our validation to whoever is probing it, and none of those
   * distinctions changes what a legitimate client does next.
   */
  async verify(
    idToken: string,
    expectedNonce?: string,
  ): Promise<TelegramIdentity> {
    let payload: JWTPayload;

    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        // EdDSA and ES256K are offered by Telegram but reject the `profile` and
        // `phone` scopes, so they cannot carry the phone number this product needs.
        algorithms: ['RS256', 'ES256'],
        maxTokenAge: this.maxTokenAgeSeconds,
        // Small allowance for clock skew between Telegram and this host, in both
        // directions. Larger would widen the replay window `maxTokenAge` exists to
        // close.
        clockTolerance: 30,
      }));
    } catch (error) {
      this.logger.warn(
        `Telegram id_token rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new UnauthorizedError('auth.telegram_token_invalid');
    }

    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      this.logger.warn('Telegram id_token carried an unexpected nonce');
      throw new UnauthorizedError('auth.telegram_token_invalid');
    }

    return this.toIdentity(payload);
  }

  private toIdentity(payload: JWTPayload): TelegramIdentity {
    // `sub` is the OIDC subject and is what identifies the account. The `id` claim
    // from the `profile` scope is the same value, but `sub` is present with only
    // `openid` granted, so it is the one relied on.
    const telegramUserId = payload.sub;

    if (!telegramUserId) {
      this.logger.error('Telegram id_token verified but carried no sub claim');
      throw new UnauthorizedError('auth.telegram_token_invalid');
    }

    // Only a phone Telegram itself reports as verified is usable: an unverified
    // value would let a login attach to an existing account by claiming its number.
    const verifiedPhone =
      payload.phone_number_verified === true &&
      typeof payload.phone_number === 'string'
        ? payload.phone_number
        : null;

    if (this.requirePhone && !verifiedPhone) {
      // Refused rather than accepted-without-a-phone: BR-09 and §11.1 are about
      // revealing a candidate's contact details to an employer, and an account with
      // no phone number silently cannot participate in that. Better to say so at
      // login than to let the user discover it after building a profile.
      throw new UnauthorizedError('auth.telegram_phone_required');
    }

    return {
      telegramUserId,
      username:
        typeof payload.preferred_username === 'string'
          ? payload.preferred_username
          : null,
      verifiedPhone,
      displayName: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
