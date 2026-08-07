import { Module } from '@nestjs/common';

import { IdempotencyModule } from '@infra/idempotency/idempotency.module';
import { ApplicationsModule } from '@modules/applications/applications.module';
import { DictionariesModule } from '@modules/dictionaries/dictionaries.module';
import { EmployersModule } from '@modules/employers/employers.module';

import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Direct employer invitations (M7, §8.2).
 *
 * `ApplicationsModule` is imported for `CandidateViewService`, which serves the
 * invitation-scoped file download - BR-09's decision belongs to the one place that
 * evaluates it, and an accepted invitation is now one of its two interactions.
 *
 * The dependency runs in exactly one direction, and that is deliberate: the exposure
 * gatherer reads the `invitations` table with a query of its own rather than injecting
 * this service back. Reading another module's table is what every service here already
 * does; a module cycle would be a structural problem in exchange for one `SELECT`.
 *
 * Exported because M8's chat is gated on a permitted interaction existing (§9.1), and
 * §8.2 says acceptance "enables the corresponding communication flow" - so the gate reads
 * these invitations rather than inventing a second notion of who may talk to whom.
 */
@Module({
  imports: [
    IdempotencyModule,
    EmployersModule,
    DictionariesModule,
    ApplicationsModule,
  ],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
