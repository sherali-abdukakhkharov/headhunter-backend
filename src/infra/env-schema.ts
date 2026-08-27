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
   * Human-readable logs through `pino-pretty` instead of raw JSON.
   *
   * Separate from `NODE_ENV` because they are different concerns, and the
   * container proves it: this deployment runs with `NODE_ENV=development` on
   * purpose (the fixed OTP code is refused in production), but it must still emit
   * JSON, because `pino-pretty` is a devDependency and the image carries
   * production dependencies only. Tying the two together made the container crash
   * at boot on an unresolvable transport.
   */
  LOG_PRETTY: boolean;

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

  /**
   * Whether a verification submission waits for a human decision (§6.1).
   *
   * **On since M10** (2026-08-07), which is what it was always waiting for: §10.2's
   * queue and `POST /admin/verification/{id}` give a submission somebody who *can*
   * decide it. Turning it on needed no client change, exactly as promised - the five
   * statuses, the transitions, the evidence requirement and BR-03 were all implemented
   * from M4.
   *
   * It stays a flag, and the reason changed rather than disappeared: an instance with
   * no administrator account yet has to be able to turn it off, or every employer parks
   * in `under_review` with nobody to decide. The first administrator is granted by SQL
   * (`INSERT INTO user_roles`) - `POST /auth/roles` refuses `admin` by design, and there
   * is deliberately no route that grants it.
   *
   * With it off, submitting transitions straight to `verified` and still writes its
   * BR-08 history row with a null actor and an `auto_verified_no_reviewer` reason, so
   * the trail never claims a person reviewed anything.
   */
  EMPLOYER_VERIFICATION_ENABLED: boolean;

  /**
   * Whether a submitted vacancy waits for a moderator (§6.4, BR-04).
   *
   * **On since M10** (2026-08-07): §10.2's queue and `POST /admin/moderation/{id}` are
   * the moderator BR-04 always assumed. With it off, submit transitions `draft → active`
   * directly, still writing its BR-08 row with a null actor and an
   * `auto_approved_no_moderator` reason.
   *
   * *The part that never depended on this flag:* a vacancy carrying a BR-12 age or
   * gender restriction is sent for review **regardless**, because BR-12 makes
   * "administrator review" part of the rule. From M5 until M10 that meant such a vacancy
   * could not publish at all - the right failure, and now a resolved one: the moderation
   * queue shows which items carry a restriction, and approving one is the only way it
   * ever publishes.
   *
   * It stays a flag for the same reason as `EMPLOYER_VERIFICATION_ENABLED`: an instance
   * with no administrator account has to be able to turn it off.
   */
  MODERATION_ENABLED: boolean;

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
  /** §12.5's search bucket. A search is a heavy read, so it gets its own budget. */
  RATE_LIMIT_SEARCH_PER_IP: number;
  /**
   * §12.5's messaging bucket, and the last of its five.
   *
   * Generous on purpose: a real conversation is bursty, and the abuse this guards against
   * is a script rather than somebody typing quickly. §9.1's block is what answers one
   * person harassing another; this answers one machine.
   */
  RATE_LIMIT_MESSAGING_PER_IP: number;

  /**
   * Payment provider callbacks (§6.7, M13).
   *
   * The loosest bucket in the product, and deliberately so: the caller is Payme or CLICK
   * retrying, which BR-19 makes harmless, and throttling a provider out of delivering a
   * `PerformTransaction` would mean money taken with no Coins credited. What it guards is a
   * flood from something that is not the provider.
   */
  RATE_LIMIT_PAYMENTS_PER_IP: number;

  /**
   * The Firebase service-account JSON, base64-encoded, or empty to disable push.
   *
   * Base64 because the document is multi-line and its private key contains newlines,
   * which `.env` files handle badly enough that most failures would be quoting mistakes.
   *
   * **Empty is a supported state, not a broken one** (§9.2): notifications are still
   * stored and read in-app, and the no-op sender logs a warning per dispatch rather than
   * claiming a delivery. The same shape as `OTP_STATIC_CODE` on the login path - the
   * product is complete before the third-party account exists, and the credential's
   * arrival changes configuration rather than code.
   */
  FCM_SERVICE_ACCOUNT_BASE64: string;
  /** How long to wait on Google, per request. Push is best effort; nothing retries. */
  FCM_TIMEOUT_MS: number;

  /**
   * OTP delivery through Eskiz.uz (§4.1, docs/SMS_PROVIDER.md).
   *
   * **Empty is a supported state**, exactly as for FCM: the login flow is complete and
   * tested without a provider, because `OTP_STATIC_CODE` fixes the code and
   * `OTP_ECHO_IN_RESPONSE` returns it. With these empty the logging sender runs, which
   * reports `failed` rather than pretending.
   *
   * The credential is an account **login**, not an issued key - Eskiz has no API key, so
   * the token is obtained with these and refreshed when it expires. That is why there
   * are two variables here and not one.
   */
  ESKIZ_EMAIL: string;
  ESKIZ_PASSWORD: string;
  /** The originator on the account: the shared short code, or a branded sender. */
  ESKIZ_FROM: string;
  ESKIZ_BASE_URL: string;
  /** A login screen is waiting on this, so it is shorter than the file timeouts. */
  ESKIZ_TIMEOUT_MS: number;

  /**
   * The Coin economy (§6.6, §10.5).
   *
   * §6.6 requires these to be "server-side business configuration, not hard-coded in
   * Flutter", and §10.5 adds that changing one "affects future transactions only and does
   * not rewrite historical ledger records" - which is why every wallet transaction stores
   * the price it was priced at instead of deriving it at read time.
   *
   * Environment variables rather than an administrator-editable table, because §10.5
   * calls them "server configuration values": a price change is a deployment decision
   * with an audit trail in git, not a button somebody can press twice.
   */
  COIN_PRICE_UZS: number;
  CANDIDATE_UNLOCK_COINS: number;
  EMPLOYER_REGISTRATION_BONUS_COINS: number;

  /**
   * How many invitations one employer may send per calendar day (§8.2).
   *
   * **Sending an invitation is free** - §7.3 lists it beside "View profile" and "Save", and
   * §7.4's own worked example fills twenty openings by inviting people, which at 2 Coins each
   * would cost more than the registration bonus covers five times over. The candidate's
   * *acceptance* is what opens contact. So this cap is what stands in for a price: BR-03's
   * verification is an admission gate, not a volume limit, and it stops strangers rather than
   * a verified employer behaving badly.
   *
   * Configuration rather than a constant for the reason the Coin price is (§6.6, §10.5): the
   * client renders the figure this server sends and holds no number of its own, so raising the
   * cap is a deployment decision and not an app release. When invitations become purchasable
   * this stays the *free* allowance and the effective limit becomes a sum - which is why
   * `GET /invitations/quota` reports one total rather than two tiers.
   */
  EMPLOYER_DAILY_INVITATION_LIMIT: number;

  /**
   * How many Coins one order may buy (§6.7, M13).
   *
   * A floor and a ceiling, because the amount an order asks for becomes a real charge at a
   * real provider. The ceiling is not a business rule anybody stated - it is a guard
   * against a client sending 10^9, which would create an order for a sum no employer meant
   * to authorize and would sit in the reconciliation trail forever.
   */
  PAYMENT_MIN_COINS: number;
  PAYMENT_MAX_COINS: number;

  /**
   * Payme Merchant API (§6.7, §12.6, docs/PAYMENTS.md).
   *
   * **Empty is a supported state**, as it is for Eskiz and FCM: the whole flow is built and
   * tested without an account, and with these empty the adapter refuses every callback
   * rather than pretending one succeeded. Boot does not refuse them in production - an
   * instance that cannot sell Coins is degraded, not unsafe.
   *
   * `PAYME_MERCHANT_KEY` is the password half of the Basic credential Payme authenticates
   * its callbacks with; the username is the fixed string `Paycom`. It is a **secret**, and
   * BR-22 requires it to live only here.
   *
   * `PAYME_ACCOUNT_FIELD` is the name Payme was told our order id would arrive under when
   * the cash-box was created. It is configuration because it is *their* setting: a mismatch
   * makes every callback fail as "order not found", which is a confusing way to find out.
   */
  PAYME_MERCHANT_ID: string;
  PAYME_MERCHANT_KEY: string;
  PAYME_CHECKOUT_URL: string;
  PAYME_ACCOUNT_FIELD: string;

  /**
   * CLICK Shop API (§6.7, §12.6, docs/PAYMENTS.md).
   *
   * Same rule: empty means the adapter refuses. `CLICK_SECRET_KEY` is what the `Prepare`
   * and `Complete` signatures are computed with, so it is the credential BR-22 keeps out of
   * the app. `CLICK_MERCHANT_USER_ID` is only needed for CLICK's outbound API, which this
   * milestone does not call - it is carried so that connecting the account is one edit to
   * one file.
   */
  CLICK_MERCHANT_ID: string;
  CLICK_SERVICE_ID: string;
  CLICK_SECRET_KEY: string;
  CLICK_MERCHANT_USER_ID: string;
  CLICK_CHECKOUT_URL: string;

  /**
   * How far §7.2's count-before-open counts before answering "n+".
   *
   * Configuration rather than a constant for the reason every other limit here is: the
   * number at which an exact count stops being "technically reasonable" depends on the
   * size of the database it runs against.
   */
  SEARCH_COUNT_CAP: number;

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

  // Defaults to on outside production, which is what a developer watching a
  // terminal wants. The container sets it to false explicitly.
  LOG_PRETTY: Joi.boolean().default(
    (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'production',
  ),

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

  // **On since M10**, which gives submissions a reviewer (§10.2). It stays a flag
  // because an instance with no administrator account yet has to be able to turn it
  // off: otherwise every employer parks in `under_review` with nobody to decide.
  //
  // **Refused in production** (MT-003), by the same mechanism as the OTP backdoors
  // rather than by a deploy checklist. The escape hatch exists for an instance with
  // nobody to approve anything, and a production instance has `SEED_ADMIN_PHONES` -
  // seeding runs against the database, not through this API, so there is no
  // chicken-and-egg to solve here.
  EMPLOYER_VERIFICATION_ENABLED: Joi.boolean()
    .default(true)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid(true).messages({
        'any.only':
          'EMPLOYER_VERIFICATION_ENABLED must be true when NODE_ENV=production: ' +
          '§6.1 requires a human decision, and off means every employer ' +
          'self-verifies',
      }),
    }),

  // **On since M10**, which gives vacancies a moderator (§10.2, BR-04). Same caveat as
  // above: an instance with no administrator has to be able to turn it off.
  //
  // **Refused in production**, and this one is MT-003 itself: three audits running
  // found it false on the deployed API. Off, a vacancy publishes without anyone
  // reviewing it - so §6.4, BR-04, BR-12, UAT-05 and UAT-11 are all unenforced while
  // the moderation *screen* exists and looks like it is doing something. The
  // existence of a queue is not the rule; this flag is.
  //
  // Refusing at boot rather than warning is the whole point: a warning is what the
  // last three audits found being ignored.
  MODERATION_ENABLED: Joi.boolean()
    .default(true)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid(true).messages({
        'any.only':
          'MODERATION_ENABLED must be true when NODE_ENV=production: off, a ' +
          'vacancy becomes discoverable with no administrator decision (BR-04)',
      }),
    }),

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
  // Looser than files and tighter than auth: a search is one deliberate action per
  // screen, but an employer refining filters legitimately fires several per minute.
  RATE_LIMIT_SEARCH_PER_IP: Joi.number().integer().min(1).default(240),
  RATE_LIMIT_MESSAGING_PER_IP: Joi.number().integer().min(1).default(600),
  // A provider retrying is expected traffic; a thousand an hour from one address is not.
  RATE_LIMIT_PAYMENTS_PER_IP: Joi.number().integer().min(1).default(1_200),

  // §7.2: "the current number of matching candidates ... where technically reasonable".
  // 200 is where a client renders "200+" rather than a number anyone reads.
  SEARCH_COUNT_CAP: Joi.number().integer().min(1).default(200),

  // Push (§9.2). Empty by default and empty is fine - see AppEnv. Unlike
  // OTP_STATIC_CODE this is *not* refused in production: an instance with no push is a
  // degraded instance, not an unsafe one, and the in-app list still carries every notice.
  FCM_SERVICE_ACCOUNT_BASE64: Joi.string().allow('').default(''),
  FCM_TIMEOUT_MS: Joi.number().integer().min(1000).default(10_000),

  // SMS (§4.1). Empty by default, and empty is fine for the same reason as push: the
  // login path works on OTP_STATIC_CODE and the logging sender never claims a delivery.
  // Both are required together - an email with no password is a misconfiguration that
  // would otherwise surface as a failed login at the worst moment - and neither is
  // refused in production, because an instance whose SMS is down is degraded rather
  // than unsafe.
  ESKIZ_EMAIL: Joi.string().allow('').default(''),
  ESKIZ_PASSWORD: Joi.string()
    .allow('')
    .default('')
    .when('ESKIZ_EMAIL', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).messages({
        'string.empty': 'ESKIZ_PASSWORD is required when ESKIZ_EMAIL is set',
      }),
    }),
  ESKIZ_FROM: Joi.string().default('4546'),
  ESKIZ_BASE_URL: Joi.string().uri().default('https://notify.eskiz.uz'),
  ESKIZ_TIMEOUT_MS: Joi.number().integer().min(1000).default(10_000),

  // The Coin economy (§6.6). The defaults are the specification's stated initial values:
  // 1 Coin = UZS 10 000, an unlock costs 2 Coins, a new employer gets 10 free.
  //
  // `min(1)` on the unlock cost is deliberate: a free unlock would make BR-16's
  // "charged once per pair" vacuous and would leave contact details behind a gate that
  // opens for everybody, which is the opposite of what §11.1 asks for. Zero is a
  // configuration mistake, not a business decision, so boot refuses it.
  COIN_PRICE_UZS: Joi.number().integer().min(1).default(10_000),
  CANDIDATE_UNLOCK_COINS: Joi.number().integer().min(1).default(2),
  // Zero *is* allowed here: an instance that gives no free Coins is a pricing decision.
  EMPLOYER_REGISTRATION_BONUS_COINS: Joi.number().integer().min(0).default(10),

  // §8.2's daily invitation cap. 30 is the mobile team's recommendation and the reasoning is
  // worth keeping: §7.4's example needs roughly sixty invitations to fill twenty openings, so
  // 30/day completes it in two days - a normal pace for a hiring campaign. A small employer
  // sending five or ten a day never meets it, a blast of thousands is stopped, and it leaves a
  // future paid tier something to sell. `min(1)` because zero would disable invitations
  // entirely, which is a way to break §8.2 by configuration rather than a pricing decision.
  EMPLOYER_DAILY_INVITATION_LIMIT: Joi.number().integer().min(1).default(30),

  // Top-up bounds (§6.7). One Coin is the smallest purchase that means anything, and the
  // ceiling exists so a malformed client cannot open an order for a sum nobody authorized.
  // 1 000 Coins is UZS 10 000 000 at the initial price - far above any real top-up and far
  // below a number that would look like an incident.
  PAYMENT_MIN_COINS: Joi.number().integer().min(1).default(1),
  PAYMENT_MAX_COINS: Joi.number().integer().min(1).default(1_000),

  // Payme and CLICK (§6.7, §12.6). Every credential defaults to empty, and empty means the
  // adapter refuses rather than pretends - the same arrangement as Eskiz and FCM, for the
  // same reason: the flow must be complete and testable before a merchant account exists.
  //
  // Each provider's secret is required *together with* its ids, because half a credential
  // is a misconfiguration that would otherwise surface as a failed callback at the worst
  // possible moment - after an employer has paid.
  PAYME_MERCHANT_ID: Joi.string().allow('').default(''),
  PAYME_MERCHANT_KEY: Joi.string()
    .allow('')
    .default('')
    .when('PAYME_MERCHANT_ID', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).messages({
        'string.empty':
          'PAYME_MERCHANT_KEY is required when PAYME_MERCHANT_ID is set',
      }),
    }),
  PAYME_CHECKOUT_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://checkout.paycom.uz'),
  PAYME_ACCOUNT_FIELD: Joi.string().min(1).default('order_id'),

  CLICK_MERCHANT_ID: Joi.string().allow('').default(''),
  CLICK_SERVICE_ID: Joi.string().allow('').default(''),
  CLICK_SECRET_KEY: Joi.string()
    .allow('')
    .default('')
    .when('CLICK_SERVICE_ID', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).messages({
        'string.empty':
          'CLICK_SECRET_KEY is required when CLICK_SERVICE_ID is set',
      }),
    }),
  CLICK_MERCHANT_USER_ID: Joi.string().allow('').default(''),
  CLICK_CHECKOUT_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://my.click.uz/services/pay'),

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
