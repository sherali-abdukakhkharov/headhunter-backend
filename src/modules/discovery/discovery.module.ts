import { Module } from '@nestjs/common';

import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

/**
 * Candidate-facing vacancy discovery (M6, §5.5, §5.6).
 *
 * Separate from `vacancies` and from `candidate-search` (M7) on purpose - all three are
 * "search", and they differ in who may call them, what they filter on and how they rank.
 * ARCHITECTURE.md §2: merging them produces a permission-shaped mess.
 */
@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
