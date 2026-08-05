import { Module } from '@nestjs/common';

import { IdempotencyService } from './idempotency.service';

/**
 * `Idempotency-Key` support (ARCHITECTURE.md §7).
 *
 * In `infra` rather than in a feature module because §12.4 names four operations that
 * need it - apply, invite, send message, schedule interview - across M6, M7 and M8, and
 * none of them owns the mechanism.
 */
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
