import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { normalizePhone } from '@infra/phone/phone';
import {
  type RateLimitBucket,
  type RateLimitKey,
  RateLimitService,
} from '@infra/rate-limit/rate-limit.service';

import { RATE_LIMIT_BUCKET_KEY } from '../decorators/rate-limit.decorator';
import { TooManyRequestsError } from '../exceptions/localized.exception';

/**
 * Enforces the §12.5 buckets on routes carrying `@RateLimit`.
 *
 * Runs **first** in the global guard stack, before authentication: refusing an
 * abusive caller must not require verifying a JWT and reading the session row
 * first, since that database round trip is exactly what a flood would amplify.
 * The consequence is that only request-visible keys work here (IP, and the phone
 * in the body). A future bucket keyed by user id - search, messaging - moves this
 * guard after `AuthorizationGuard`.
 *
 * Routes without the decorator pass through.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.getAllAndOverride<
      RateLimitBucket | undefined
    >(RATE_LIMIT_BUCKET_KEY, [context.getHandler(), context.getClass()]);

    if (!bucket) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    for (const rule of this.limits.rulesFor(bucket)) {
      const value = subjectValue(rule.key, request);

      // A rule whose key is absent from this request is skipped rather than
      // failing the request: `POST /auth/refresh` carries no phone, and the IP
      // rule still applies to it.
      if (!value) {
        continue;
      }

      const verdict = await this.limits.consume(
        bucket,
        rule.key,
        value,
        rule.limit,
      );

      if (!verdict.allowed) {
        // Returning on the first denial leaves the remaining counters
        // un-incremented, which is intended: a request already refused should
        // not also consume the caller's budget in another bucket.
        throw new TooManyRequestsError(
          'error.too_many_requests',
          verdict.retryAfterSeconds,
        );
      }
    }

    return true;
  }
}

function subjectValue(key: RateLimitKey, request: Request): string | null {
  if (key === 'ip') {
    // `request.ip` honours `trust proxy`, which is off unless TRUSTED_PROXY_HOPS
    // says otherwise - see main.ts. Trusting a forwarded header by default would
    // let any caller spoof its address and empty this bucket at will.
    return request.ip ?? null;
  }

  // Guards run before the global ValidationPipe, so the body here is unvalidated
  // input. Anything unusable skips the phone rule and is refused a moment later
  // by validation.
  const body = request.body as Record<string, unknown> | undefined;
  const raw = body?.phone;

  if (typeof raw !== 'string') {
    return null;
  }

  try {
    // Normalized so that reformatting the same number cannot open a fresh
    // budget.
    return normalizePhone(raw);
  } catch {
    return null;
  }
}
