import { HttpException, HttpStatus } from '@nestjs/common';

import type { MessageKey, MessageParams } from '@infra/i18n/messages';

/**
 * An error whose message is chosen by the **request's** locale, not by the
 * throw site (§3.2).
 *
 * The exception carries a catalog key and its parameters; `ApiExceptionFilter`
 * renders it once it knows the caller's `x-lang`. That split is the whole point:
 * a service deep in the stack has no business knowing the request language, and
 * threading a locale through every method signature to build an error string
 * would be worse than the English-only strings this replaces.
 *
 * The key doubles as the response's machine-readable `code`, so a client can
 * branch on the cause without matching translated prose.
 *
 * **`params` interpolate the message and are not in the response body.** If a client needs a
 * number rather than a sentence containing it, pass `details` as well - see below. Reading a
 * figure back out of localized prose is the thing `details` exists to prevent.
 */
export class LocalizedException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly messageKey: MessageKey,
    readonly params?: MessageParams,
    /** Seconds the caller must wait; rendered as `Retry-After` (§12.5). */
    readonly retryAfterSeconds?: number,
    /**
     * Machine-readable facts about *this* refusal, rendered as a `details` object beside
     * `code` and `message`.
     *
     * Opt-in per throw site rather than a blanket spread of `params`, for two reasons: a
     * parameter is written to read well in a sentence and is not always a fact worth exposing,
     * and spreading arbitrary keys at the top level of an error body would eventually collide
     * with `statusCode`, `code` or `message`.
     *
     * Use it when a client would otherwise have to parse the message or make a second request
     * - a quota's reset time, a balance a screen needs to refresh. Not for anything the caller
     * is not already entitled to see: this is an error body, so it is the least reviewed
     * response shape in the product.
     */
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    // The key is the fallback body for anything that bypasses the filter - a
    // log line, or a test asserting on the raw exception.
    super(messageKey, status);
  }
}

/** 400 - the request itself is malformed or contradictory. */
export class BadRequestError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.BAD_REQUEST, key, params);
  }
}

/** 401 - not authenticated, or the credential presented is no longer usable. */
export class UnauthorizedError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.UNAUTHORIZED, key, params);
  }
}

/** 403 - authenticated, but not permitted (role, ownership, account status). */
export class ForbiddenError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.FORBIDDEN, key, params);
  }
}

/** 404 - and deliberately also used to hide another account's resources. */
export class NotFoundError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.NOT_FOUND, key, params);
  }
}

/**
 * 409 - the request is valid but the resource's current state forbids it.
 *
 * Distinct from 403 on purpose: a 403 means "not you", a 409 means "not now". A
 * client retrying a 409 after the state changes is correct behaviour, which is not
 * true of a 403.
 */
export class ConflictError extends LocalizedException {
  constructor(
    key: MessageKey,
    params?: MessageParams,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(HttpStatus.CONFLICT, key, params, undefined, details);
  }
}

/** 413 - the upload exceeds the configured limit (§12.5). */
export class PayloadTooLargeError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.PAYLOAD_TOO_LARGE, key, params);
  }
}

/**
 * 429 - a rate-limit bucket, an OTP resend delay, or an attempt lockout.
 *
 * `retryAfterSeconds` is optional because not every 429 has an answer: an OTP
 * locked out by wrong guesses is not waiting for a clock, it needs a new code.
 */
export class TooManyRequestsError extends LocalizedException {
  constructor(
    key: MessageKey,
    retryAfterSeconds?: number,
    params?: MessageParams,
  ) {
    super(HttpStatus.TOO_MANY_REQUESTS, key, params, retryAfterSeconds);
  }
}

/**
 * 402 - the employer has too few Coins for what they asked for (§6.6).
 *
 * A status of its own rather than a 409, because the client's response to it is specific:
 * §6.6 says the user "is routed to wallet top-up", and routing on a status code is more
 * robust than matching a message key.
 *
 * The caller passes what is needed and what is held **twice**, and deliberately: as `params`
 * so the message reads "2 needed, 1 left" in the user's language, and as `details` so the
 * screen can refresh its own counter without parsing that sentence or making a second
 * request. This docstring used to claim `params` alone achieved the second, which was wrong
 * and had been read as a promise - `params` never reach the body.
 */
export class PaymentRequiredError extends LocalizedException {
  constructor(
    key: MessageKey,
    params?: MessageParams,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(HttpStatus.PAYMENT_REQUIRED, key, params, undefined, details);
  }
}

/** 502 - an upstream dependency (the Telegram Bot API) failed. */
export class UpstreamError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.BAD_GATEWAY, key, params);
  }
}
