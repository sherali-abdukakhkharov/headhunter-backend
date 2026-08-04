import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import { TooManyRequestsException } from '../exceptions/too-many-requests.exception';

/**
 * Adds `Retry-After` to a 429 that knows how long the caller must wait, then
 * renders the response exactly as Nest's default filter would.
 *
 * A filter rather than the guard setting the header itself: the OTP resend delay
 * and the attempt lockout are thrown from deep inside `OtpService`, where there
 * is no response object and should not be one. One filter covers every 429 in
 * the product, including the buckets M11 adds.
 */
@Catch(TooManyRequestsException)
export class RetryAfterFilter implements ExceptionFilter {
  catch(exception: TooManyRequestsException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    const body = exception.getResponse();

    response.status(exception.getStatus()).json(
      // `getResponse()` is a string when the exception was constructed with a
      // plain message, which is every call site here. Wrapping it keeps the body
      // shape identical to Nest's own HttpException rendering, so a client sees
      // one error shape across all statuses.
      typeof body === 'string'
        ? {
            statusCode: exception.getStatus(),
            message: body,
            error: 'Too Many Requests',
          }
        : body,
    );
  }
}
