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
 */
export class LocalizedException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly messageKey: MessageKey,
    readonly params?: MessageParams,
    /** Seconds the caller must wait; rendered as `Retry-After` (§12.5). */
    readonly retryAfterSeconds?: number,
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

/** 502 - an upstream dependency (the Telegram Bot API) failed. */
export class UpstreamError extends LocalizedException {
  constructor(key: MessageKey, params?: MessageParams) {
    super(HttpStatus.BAD_GATEWAY, key, params);
  }
}
