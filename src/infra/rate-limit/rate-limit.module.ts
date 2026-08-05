import { Module } from '@nestjs/common';

import { RateLimitService } from './rate-limit.service';

/**
 * Rate limiting (§12.5).
 *
 * Exported because `RateLimitGuard` is registered globally in `AppModule` and
 * resolves the service from here rather than duplicating the provider.
 */
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
