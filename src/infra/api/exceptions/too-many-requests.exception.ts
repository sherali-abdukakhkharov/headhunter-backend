import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429 Too Many Requests.
 *
 * Nest ships no built-in exception for this status, and §12.5 requires five
 * distinct rate-limit buckets plus OTP resend delays and attempt lockouts - all
 * of which are 429s. One class here beats `new HttpException(msg, 429)` repeated
 * at every call site.
 *
 * `retryAfterSeconds` is carried on the exception rather than written straight
 * to the response, so a throw site deep in a service stays free of HTTP
 * plumbing. `RetryAfterFilter` turns it into the `Retry-After` header: a mobile
 * client left to guess how long to wait either hammers the endpoint or gives up
 * on a user who could have retried in a minute.
 */
export class TooManyRequestsException extends HttpException {
  constructor(
    message = 'Too many requests',
    readonly retryAfterSeconds?: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
