import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { LocaleCode } from '@infra/db/database.types';
import { normalizeLocale } from '@infra/locale/locale';
import type { MessageKey } from '@infra/i18n/messages';
import { translate } from '@infra/i18n/translate';

import { LocalizedException } from '../exceptions/localized.exception';
import { ValidationFailedException } from '../exceptions/validation-failed.exception';

/** Error body shape, uniform across every status (docs/API_CONTRACTS.md §4.6). */
interface ErrorBody {
  statusCode: number;
  /** Stable machine-readable cause. Never translated, safe to branch on. */
  code: string;
  /** Localized for the request's `x-lang`. Safe to show to a user as-is. */
  message: string;
  errors?: { code: string; rule: string; message: string }[];
}

/**
 * The single exception filter.
 *
 * Everything a client sees on a failure is produced here, for three reasons:
 *
 * 1. **This is the only layer that knows the request locale.** §3.2 requires
 *    every user-facing message in all four interface variants, and neither a
 *    service nor `ValidationPipe`'s factory has the request in hand.
 * 2. **One error shape.** A client that has to handle a different body per status
 *    ends up showing raw JSON to somebody.
 * 3. **Nothing internal escapes.** An unexpected error is logged with its stack
 *    and answered with a generic localized message - never a stack trace, an SQL
 *    fragment or a driver message, which is where dependency internals and even
 *    user data leak out (§12.1).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const locale = normalizeLocale(
      request.headers['x-lang'] as string | undefined,
    );

    const { body, retryAfterSeconds } = this.render(exception, locale);

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    response.status(body.statusCode).json(body);
  }

  private render(
    exception: unknown,
    locale: LocaleCode,
  ): { body: ErrorBody; retryAfterSeconds?: number } {
    if (exception instanceof ValidationFailedException) {
      return {
        body: {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: 'validation.failed',
          message: translate('validation.failed', locale),
          // `code` is the field code, so the client can attach each message to
          // the input that produced it (§4.6).
          errors: exception.violations.map((violation) => ({
            code: violation.field,
            rule: violation.rule,
            message: translate(violation.messageKey, locale, violation.params),
          })),
        },
      };
    }

    if (exception instanceof LocalizedException) {
      return {
        body: {
          statusCode: exception.getStatus(),
          code: exception.messageKey,
          message: translate(exception.messageKey, locale, exception.params),
          // Present only where a throw site opted in, so every existing error body is
          // byte-identical. `params` stay out of the body on purpose - they are written to
          // read well in a sentence, not to be consumed - and a client that needs the number
          // rather than the sentence gets it here instead of parsing prose.
          ...(exception.details ? { details: exception.details } : {}),
        },
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }

    if (exception instanceof HttpException) {
      // Framework-generated: an unmatched route, malformed JSON, a failed
      // ParseUUIDPipe. Answered with the generic message for that status rather
      // than Nest's English text.
      const status = exception.getStatus();
      const key = statusMessageKey(status);

      return {
        body: {
          statusCode: status,
          code: key,
          message: translate(key, locale),
        },
      };
    }

    // Anything else is a bug. Log everything, disclose nothing.
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );

    return {
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'error.internal',
        message: translate('error.internal', locale),
      },
    };
  }
}

/**
 * Generic message per status, for framework-generated failures.
 *
 * A lookup rather than a switch because the incoming value is a plain `number`
 * off `getStatus()`, and comparing that against enum members is the kind of
 * almost-typed code the lint rules exist to reject.
 */
const STATUS_MESSAGES = new Map<number, MessageKey>([
  [HttpStatus.BAD_REQUEST, 'error.bad_request'],
  [HttpStatus.UNAUTHORIZED, 'error.unauthorized'],
  [HttpStatus.FORBIDDEN, 'error.forbidden'],
  [HttpStatus.NOT_FOUND, 'error.not_found'],
  [HttpStatus.CONFLICT, 'error.conflict'],
  [HttpStatus.PAYLOAD_TOO_LARGE, 'error.payload_too_large'],
  [HttpStatus.TOO_MANY_REQUESTS, 'error.too_many_requests'],
  [HttpStatus.SERVICE_UNAVAILABLE, 'error.service_unavailable'],
]);

function statusMessageKey(status: number): MessageKey {
  return (
    STATUS_MESSAGES.get(status) ??
    (status >= 500 ? 'error.internal' : 'error.bad_request')
  );
}
