import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { IdempotencyModule } from '@infra/idempotency/idempotency.module';
import { EmployersModule } from '@modules/employers/employers.module';

import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { CandidateViewService } from './candidate-view.service';

/**
 * Applications and hiring stages (M6, §5.6, §6.5, §8.1).
 *
 * `EmployersModule` supplies BR-09's "is this a verified employer" half; the interaction
 * half comes from this module's own applications. That pairing is why BR-09 could not be
 * built in M3 - neither input existed yet.
 *
 * Exported because M8's chat is gated on an interaction existing (§9.1), and that gate
 * reads the same applications rather than a second notion of "may these two talk".
 *
 * `CandidateViewService` is exported for M7's candidate search, whose §7.3 "View profile"
 * action is the same read from a different starting point. One gatherer for BR-09's three
 * inputs, not two: ARCHITECTURE.md §8 is explicit that a privacy rule with two
 * implementations is a privacy rule that drifts.
 */
@Module({
  imports: [IdempotencyModule, EmployersModule, FilesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, CandidateViewService],
  exports: [ApplicationsService, CandidateViewService],
})
export class ApplicationsModule {}
