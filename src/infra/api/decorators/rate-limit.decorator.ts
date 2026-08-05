import { type CustomDecorator, SetMetadata } from '@nestjs/common';

import type { RateLimitBucket } from '@infra/rate-limit/rate-limit.service';

export const RATE_LIMIT_BUCKET_KEY = 'rate_limit_bucket';

/**
 * Counts this route against one of the §12.5 buckets.
 *
 * The decorator names the bucket only; the limits are server configuration
 * resolved by `RateLimitService`, because §4.2 and §12.5 both require these
 * numbers to be tunable per deployment rather than compiled in.
 */
export const RateLimit = (bucket: RateLimitBucket): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT_BUCKET_KEY, bucket);
