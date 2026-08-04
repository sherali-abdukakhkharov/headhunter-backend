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
})
  // DATABASE_URL is consumed by kysely-codegen and the migration runner, not
  // by the app, so it is permitted but not required here.
  .unknown(true);
