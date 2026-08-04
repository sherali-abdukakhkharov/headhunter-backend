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

  OTP_LENGTH: number;
  OTP_TTL_SECONDS: number;
  OTP_RESEND_DELAY_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  /** Development only: return the OTP in the send response instead of an SMS. */
  OTP_ECHO_IN_RESPONSE: boolean;

  /**
   * Number of reverse proxies in front of this service.
   *
   * `0` means `X-Forwarded-For` is ignored and `request.ip` is the socket
   * address. Anything higher trusts that many hops, which is required for
   * per-IP rate limiting to see the real caller behind a proxy - and, if set
   * without a proxy actually being there, lets a caller spoof its own address.
   */
  TRUSTED_PROXY_HOPS: number;

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

  // Defaults to not trusting any forwarded header: an over-permissive value is
  // a rate-limit bypass, while too low a value only makes the limit stricter.
  TRUSTED_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),

  // §12.5 buckets. One shared window keeps the surface small; per-phone limits
  // are tight because each send costs an SMS, per-IP limits are loose because
  // mobile networks here NAT many users behind one address.
  RATE_LIMIT_WINDOW_SECONDS: Joi.number().integer().min(60).default(3600),
  RATE_LIMIT_OTP_PER_PHONE: Joi.number().integer().min(1).default(5),
  RATE_LIMIT_OTP_PER_IP: Joi.number().integer().min(1).default(30),
  RATE_LIMIT_AUTH_PER_PHONE: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_AUTH_PER_IP: Joi.number().integer().min(1).default(120),
  RATE_LIMIT_FILES_PER_IP: Joi.number().integer().min(1).default(120),

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
