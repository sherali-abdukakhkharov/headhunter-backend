import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import { hashSecret } from '@infra/crypto/hash';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';

/** The §12.5 buckets that exist today. Search, messaging and files join at M11. */
export type RateLimitBucket = 'otp' | 'auth';

/** What a bucket is counted by. A request missing the value skips that rule. */
export type RateLimitKey = 'ip' | 'phone';

export interface RateLimitRule {
  key: RateLimitKey;
  limit: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the window rolls over - served as `Retry-After`. */
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimitService {
  private readonly pepper: string;
  private readonly windowSeconds: number;
  private readonly rules: Record<RateLimitBucket, RateLimitRule[]>;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.pepper = config.get('TOKEN_HASH_PEPPER', { infer: true });
    this.windowSeconds = config.get('RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });

    // Limits are configuration, so the decorator names a bucket and the numbers
    // are resolved here. A per-IP limit is deliberately far looser than a
    // per-phone one: Uzbek mobile networks NAT heavily, so one address
    // legitimately carries many users, while one phone number does not.
    this.rules = {
      otp: [
        {
          key: 'phone',
          limit: config.get('RATE_LIMIT_OTP_PER_PHONE', { infer: true }),
        },
        {
          key: 'ip',
          limit: config.get('RATE_LIMIT_OTP_PER_IP', { infer: true }),
        },
      ],
      auth: [
        {
          key: 'phone',
          limit: config.get('RATE_LIMIT_AUTH_PER_PHONE', { infer: true }),
        },
        {
          key: 'ip',
          limit: config.get('RATE_LIMIT_AUTH_PER_IP', { infer: true }),
        },
      ],
    };
  }

  rulesFor(bucket: RateLimitBucket): RateLimitRule[] {
    return this.rules[bucket];
  }

  /**
   * Counts one attempt and reports whether it is within the limit.
   *
   * The whole decision is one upsert. The alternative - read, compare, write -
   * lets two concurrent requests both read the same count and both be allowed,
   * which is precisely the burst a limiter exists to stop.
   *
   * `now()` is the database clock throughout: with several app instances their
   * wall clocks differ, and a window boundary computed per instance would place
   * the same request in different windows depending on which replica served it.
   */
  async consume(
    bucket: RateLimitBucket,
    key: RateLimitKey,
    value: string,
    limit: number,
  ): Promise<RateLimitVerdict> {
    const subject = key === 'phone' ? hashSecret(value, this.pepper) : value;
    const window = this.windowSeconds;

    const result = await sql<{ hits: number; retry_after: number }>`
      INSERT INTO rate_limit_counters (bucket, subject, window_start, hits)
      VALUES (
        ${bucket},
        ${subject},
        to_timestamp(floor(extract(epoch FROM now()) / ${window}) * ${window}),
        1
      )
      ON CONFLICT (bucket, subject) DO UPDATE SET
        hits = CASE
          WHEN rate_limit_counters.window_start < excluded.window_start THEN 1
          ELSE rate_limit_counters.hits + 1
        END,
        window_start = GREATEST(
          rate_limit_counters.window_start,
          excluded.window_start
        )
      RETURNING
        hits,
        ceil(
          extract(epoch FROM window_start) + ${window}
            - extract(epoch FROM now())
        )::int AS retry_after
    `.execute(this.db);

    const row = result.rows[0];

    return {
      allowed: row.hits <= limit,
      retryAfterSeconds: Math.max(row.retry_after, 1),
    };
  }
}
