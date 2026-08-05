import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
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

/**
 * The claims we rely on, from the `openid`, `profile` and `phone` scopes.
 *
 * Confirmed against Telegram's live `claims_supported`: `aud preferred_username
 * phone_number exp iat iss name picture sub`. Nothing here depends on a claim
 * Telegram does not advertise - in particular not `id`, `given_name` or
 * `family_name`, which the prose documentation mentions but the discovery document
 * does not list.
 */
export interface TelegramIdentity {
  /** Telegram user id, from `sub`. The credential; stable, always present. */
  telegramUserId: string;
  /** `@username` without the `@`. Optional on Telegram and user-changeable. */
  username: string | null;
  /** From the `phone` scope. See `toIdentity` on what "verified" means here. */
  verifiedPhone: string | null;
  displayName: string | null;
}

@Injectable()
export class TelegramOidcService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramOidcService.name);

  private readonly issuer: string;
  private readonly audience: string;
  private readonly maxTokenAgeSeconds: number;
  private readonly requirePhone: boolean;
  private readonly botTokenPrefix: string | null;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<AppEnv, true>) {
    this.issuer = config.get('TELEGRAM_OIDC_ISSUER', { infer: true });
    this.audience = config.get('TELEGRAM_LOGIN_BOT_ID', { infer: true });
    this.maxTokenAgeSeconds = config.get('TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS', {
      infer: true,
    });
    this.requirePhone = config.get('TELEGRAM_REQUIRE_PHONE', { infer: true });

    // Only the public numeric prefix is kept, for the boot-time check below - never
    // the secret half. Defensive about the value's absence: this service must not be
    // the reason a process fails to start over a diagnostic it only logs.
    const botToken: unknown = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.botTokenPrefix =
      typeof botToken === 'string' ? botToken.split(':')[0] || null : null;

    // Built once: the key set is cached across requests and refetched only on an
    // unknown `kid`, with a cooldown so a token carrying a bogus kid cannot be used
    // to hammer Telegram's endpoint.
    this.jwks = createRemoteJWKSet(
      new URL(config.get('TELEGRAM_JWKS_URL', { infer: true })),
      { cacheMaxAge: 600_000, cooldownDuration: 30_000 },
    );
  }

  /**
   * Says which bot logins are accepted for, and flags the one misconfiguration that
   * is genuinely hard to diagnose.
   *
   * If `TELEGRAM_LOGIN_BOT_ID` is not the bot the app authorized against, **every**
   * login fails the audience check and the client sees only
   * `auth.telegram_token_invalid` - correct behaviour, and indistinguishable from a
   * forged token, an expired one or a network problem. Since the file-storage token
   * already tells us a bot id, comparing them costs nothing and turns hours of
   * confusion into one line at start-up.
   *
   * A warning rather than a failure: using a separate bot for login and for file
   * storage is a legitimate deployment.
   */
  onApplicationBootstrap(): void {
    this.logger.log(
      `Telegram login accepts id_tokens for bot ${this.audience} from ${this.issuer}`,
    );

    if (this.botTokenPrefix && this.botTokenPrefix !== this.audience) {
      this.logger.warn(
        `TELEGRAM_LOGIN_BOT_ID (${this.audience}) is not the bot behind ` +
          `TELEGRAM_BOT_TOKEN (${this.botTokenPrefix}). Intentional if login and ` +
          'file storage use different bots - otherwise every login will be ' +
          'refused as invalid.',
      );
    }

    if (!this.requirePhone) {
      // Worth saying out loud: it is the difference between accounts that can take
      // part in hiring and accounts that silently cannot.
      this.logger.warn(
        'TELEGRAM_REQUIRE_PHONE is off - logins without a phone number are ' +
          'accepted, and those accounts cannot take part in BR-09 contact exposure.',
      );
    }
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

    // A `phone_number` from Telegram counts as verified unless Telegram explicitly
    // says otherwise.
    //
    // Requiring `phone_number_verified === true` looked like the careful reading, and
    // it is wrong: `https://oauth.telegram.org/.well-known/openid-configuration`
    // advertises `claims_supported` as `aud preferred_username phone_number exp iat
    // iss name picture sub` - no `phone_number_verified` at all. Demanding it refuses
    // every real login.
    //
    // Treating the claim's absence as verified is sound rather than merely pragmatic:
    // a Telegram account *is* a verified phone number. Telegram will not issue one
    // without confirming the number by SMS or call, so the only way it can name a
    // user's phone here is that the user proved control of it to Telegram. An
    // explicit `false` is still honoured, in case Telegram ever starts emitting it
    // for a case we have not seen.
    const claimedPhone =
      typeof payload.phone_number === 'string' ? payload.phone_number : null;

    const verifiedPhone =
      claimedPhone !== null && payload.phone_number_verified !== false
        ? claimedPhone
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
