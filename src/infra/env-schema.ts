import * as Joi from 'joi';

/**
 * Shape of the validated environment. Inject `ConfigService<AppEnv, true>` to
 * read these with full type safety.
 */
export interface AppEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  HTTP_PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
  CORS_ORIGINS: string;
  LOG_LEVEL: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

  /**
   * IANA zone every client-facing timestamp is rendered in (§8.3, single
   * platform zone). Storage stays UTC; see `infra/time/format.ts`.
   */
  PLATFORM_TIME_ZONE: string;

  JWT_SECRET: string;
  ACCESS_TOKEN_TTL_SECONDS: number;
  REFRESH_TOKEN_TTL_DAYS: number;

  /** HMAC key for OTP and refresh-token hashes. See `infra/crypto/hash.ts`. */
  TOKEN_HASH_PEPPER: string;

  /**
   * Whether the phone + OTP routes exist.
   *
   * **On for the MVP** (client direction 2026-08-05, superseding the brief
   * Telegram-login period): §4.1's phone + OTP is the login path. When off, every
   * `/auth/otp/*` route answers 404.
   */
  OTP_LOGIN_ENABLED: boolean;

  OTP_LENGTH: number;
  OTP_TTL_SECONDS: number;
  OTP_RESEND_DELAY_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  /** Development only: return the OTP in the send response instead of an SMS. */
  OTP_ECHO_IN_RESPONSE: boolean;
  /**
   * A fixed code issued instead of a random one, so the flow is testable before
   * an SMS provider exists.
   *
   * Empty disables it. When set, `OtpService.send` stores **this** code's hash in
   * exactly the place a random code's hash would go — TTL, supersession, the
   * resend delay, the attempt limit and single-use consumption all still apply.
   * That is the point: connecting a real SMS provider and clearing this variable
   * changes no code path, so nothing that worked here can break there.
   */
  OTP_STATIC_CODE: string;

  /**
   * Bot id the Telegram `id_token` must be addressed to - its `aud` claim.
   *
   * The numeric part of the bot token, before the colon. Checking it is what stops
   * a token minted for a different application being replayed here.
   */
  TELEGRAM_LOGIN_BOT_ID: string;
  TELEGRAM_OIDC_ISSUER: string;
  TELEGRAM_JWKS_URL: string;
  /**
   * How old an `id_token` may be, by its `iat`.
   *
   * The practical replay defence: a captured token is refused once this elapses,
   * even while `exp` is still in the future.
   */
  TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS: number;
  /**
   * Refuse a login whose `phone` scope was declined.
   *
   * On by default: BR-09 and §11.1 are about revealing a candidate's contact
   * details to an employer, and an account with no phone number cannot take part.
   */
  TELEGRAM_REQUIRE_PHONE: boolean;

  /**
   * Number of reverse proxies in front of this service.
   *
   * Makes Express proxy-aware, so `req.protocol`, `req.secure` and `req.hostname`
   * reflect the original request rather than the hop from the proxy. Set to `0`
   * when nothing is in front.
   *
   * **Not what per-IP rate limiting reads** - that is `CLIENT_IP_HEADER`, because
   * `X-Forwarded-For` is the wrong answer behind Cloudflare. See
   * `infra/api/client-ip.ts`.
   */
  TRUSTED_PROXY_HOPS: number;

  /**
   * Header carrying the real client IP, or empty to use the socket address.
   *
   * `cf-connecting-ip` behind a Cloudflare tunnel. Only ever read when named here:
   * with nothing in front, any caller could send the header and mint a fresh
   * rate-limit budget per request.
   */
  CLIENT_IP_HEADER: string;

  /**
   * Whether `/docs` and `/reference` are served.
   *
   * On by default - the OpenAPI document is the contract the Flutter client is
   * written against (§13.2). Behind a public hostname it also describes every
   * endpoint and payload to anyone who asks, so a public deployment should either
   * turn it off or put an access policy in front of those two paths.
   */
  API_DOCS_ENABLED: boolean;

  /**
   * Public base URL, for operator-facing output only.
   *
   * Never used to build a client-facing link: a URL derived from configuration and
   * baked into a response is the classic way an internal hostname escapes.
   */
  PUBLIC_BASE_URL: string;

  /** Window all §12.5 rate-limit buckets are counted over. */
  RATE_LIMIT_WINDOW_SECONDS: number;
  RATE_LIMIT_OTP_PER_PHONE: number;
  RATE_LIMIT_OTP_PER_IP: number;
  RATE_LIMIT_AUTH_PER_PHONE: number;
  RATE_LIMIT_AUTH_PER_IP: number;
  RATE_LIMIT_FILES_PER_IP: number;

  /**
   * Bot token for the file store. Also the download credential: Telegram's
   * `file_id` values are per-bot, so replacing this token orphans every stored
   * file rather than merely re-authenticating.
   */
  TELEGRAM_BOT_TOKEN: string;
  /** The chat every uploaded file is sent to. */
  TELEGRAM_STORAGE_CHAT_ID: string;
  TELEGRAM_API_BASE_URL: string;
  TELEGRAM_TIMEOUT_MS: number;

  /**
   * Upload ceiling. Bounded above by Telegram's **download** limit of 20 MB, not
   * its 50 MB send limit: a larger file would upload successfully and then be
   * permanently unreadable.
   */
  FILE_MAX_SIZE_BYTES: number;
}

/**
 * Validated at boot by ConfigModule. A missing or malformed variable crashes
 * the process immediately rather than surfacing as a confusing runtime error
 * on the first request.
 */
export const envSchema = Joi.object<AppEnv, true>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  HTTP_PORT: Joi.number().port().default(3000),

  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),

  CORS_ORIGINS: Joi.string().default('*'),

  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal')
    .default('info'),

  // Validated as a real IANA zone at boot rather than trusted: a typo would
  // otherwise surface as a RangeError from Intl on the first response.
  PLATFORM_TIME_ZONE: Joi.string()
    .default('Asia/Tashkent')
    .custom((value: string, helpers) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return value;
      } catch {
        return helpers.message({
          custom: `PLATFORM_TIME_ZONE "${value}" is not a valid IANA time zone`,
        });
      }
    }),

  // 32 characters minimum for both secrets: short ones are the whole attack.
  JWT_SECRET: Joi.string().min(32).required(),
  ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).default(30),

  TOKEN_HASH_PEPPER: Joi.string().min(32).required(),

  // The MVP login path (§4.1), so it defaults to on. It stays a flag because the
  // routes still need to be closable without a revert - see OtpEnabledGuard.
  OTP_LOGIN_ENABLED: Joi.boolean().default(true),

  // §4.2 requires TTL, resend delay and attempt limits to be server config -
  // never client-supplied, never hardcoded in a service.
  OTP_LENGTH: Joi.number().integer().min(4).max(8).default(6),
  OTP_TTL_SECONDS: Joi.number().integer().min(30).default(300),
  OTP_RESEND_DELAY_SECONDS: Joi.number().integer().min(0).default(60),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  // Refused outright in production rather than trusted to a deploy checklist:
  // this flag would hand any caller a login code for any phone number.
  OTP_ECHO_IN_RESPONSE: Joi.boolean()
    .default(false)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid(false).messages({
        'any.only':
          'OTP_ECHO_IN_RESPONSE must be false when NODE_ENV=production',
      }),
    }),
  // Refused in production for the same reason as the echo above, and by the same
  // mechanism rather than a checklist item: a fixed code is a master key to every
  // account on the instance. The digits-only pattern is not cosmetic - the value
  // is hashed and compared against user input, so a stray quote or trailing space
  // would produce a code nobody can type.
  OTP_STATIC_CODE: Joi.string()
    .allow('')
    .pattern(/^\d{4,8}$/)
    .default('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid('').messages({
        'any.only': 'OTP_STATIC_CODE must be empty when NODE_ENV=production',
      }),
    }),

  // Defaults to not trusting any forwarded header: an over-permissive value is
  // a rate-limit bypass, while too low a value only makes the limit stricter.
  TRUSTED_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),

  // Empty by default - the socket address. Behind Cloudflare: cf-connecting-ip.
  // Restricted to the two headers that are actually meaningful here so a typo
  // becomes a boot failure rather than a silently shared rate-limit bucket.
  CLIENT_IP_HEADER: Joi.string()
    .allow('')
    .lowercase()
    .valid('', 'cf-connecting-ip', 'x-real-ip')
    .default(''),

  API_DOCS_ENABLED: Joi.boolean().default(true),

  PUBLIC_BASE_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .allow('')
    .default(''),

  // §12.5 buckets. One shared window keeps the surface small; per-phone limits
  // are tight because each send costs an SMS, per-IP limits are loose because
  // mobile networks here NAT many users behind one address.
  RATE_LIMIT_WINDOW_SECONDS: Joi.number().integer().min(60).default(3600),
  RATE_LIMIT_OTP_PER_PHONE: Joi.number().integer().min(1).default(5),
  RATE_LIMIT_OTP_PER_IP: Joi.number().integer().min(1).default(30),
  RATE_LIMIT_AUTH_PER_PHONE: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_AUTH_PER_IP: Joi.number().integer().min(1).default(120),
  RATE_LIMIT_FILES_PER_IP: Joi.number().integer().min(1).default(120),

  // Telegram login (ARCHITECTURE.md §8). The bot id is the numeric part of the bot
  // token; it is public, and it is the audience an id_token must be addressed to.
  TELEGRAM_LOGIN_BOT_ID: Joi.string()
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.pattern.base':
        'TELEGRAM_LOGIN_BOT_ID must be the numeric bot id - the part of ' +
        'TELEGRAM_BOT_TOKEN before the colon.',
    }),
  // Pinned rather than derived from the JWKS document: the issuer is the identity
  // being trusted, so it is configuration, not something a fetched file gets to
  // tell us.
  TELEGRAM_OIDC_ISSUER: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://oauth.telegram.org'),
  // https in production, where fetching signing keys over plaintext would let
  // anyone on the path substitute their own and forge logins. `http` is permitted
  // outside production so the API can be run against a local Telegram stub - which
  // is the only way to exercise the login path without a real bot.
  TELEGRAM_JWKS_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .uri({ scheme: ['https'] })
        .messages({
          'string.uriCustomScheme':
            'TELEGRAM_JWKS_URL must be https in production: signing keys fetched ' +
            'over plaintext can be substituted, which forges every login.',
        }),
    })
    .default('https://oauth.telegram.org/.well-known/jwks.json'),
  // Five minutes: long enough for a slow handset to finish the round trip after
  // Telegram issues the token, short enough that a captured token is nearly always
  // already dead.
  TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(300),
  TELEGRAM_REQUIRE_PHONE: Joi.boolean().default(true),

  // Telegram-backed file storage (ARCHITECTURE.md §9).
  TELEGRAM_BOT_TOKEN: Joi.string().required(),
  // Accepts a numeric id (`-1001234567890` for a channel or group) or an @name.
  // Not validated as a number: channel ids are negative and beyond 32 bits, and
  // a supergroup id changes shape when a group is upgraded.
  TELEGRAM_STORAGE_CHAT_ID: Joi.string().required(),
  TELEGRAM_API_BASE_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://api.telegram.org'),
  TELEGRAM_TIMEOUT_MS: Joi.number().integer().min(1_000).default(30_000),

  // 10 MB by default, matching the client contract's `maxSizeBytes` (§4.1). The
  // 20 MB ceiling is Telegram's getFile download limit - anything above it can be
  // stored and never retrieved, so it is refused at boot rather than at upload.
  FILE_MAX_SIZE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(20 * 1024 * 1024)
    .default(10 * 1024 * 1024)
    .messages({
      'number.max':
        'FILE_MAX_SIZE_BYTES cannot exceed 20971520: the Telegram Bot API ' +
        'refuses to download files larger than 20 MB, so a bigger file could ' +
        'be uploaded but never read back.',
    }),
})
  // DATABASE_URL is consumed by kysely-codegen and the migration runner, not
  // by the app, so it is permitted but not required here.
  .unknown(true);
