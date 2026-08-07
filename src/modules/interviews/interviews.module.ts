import { Module } from '@nestjs/common';

import { ApplicationsModule } from '@modules/applications/applications.module';

import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';

/**
 * Interview scheduling (M8, §8.3).
 *
 * `ApplicationsModule` is imported for one method: `ensureInterviewStage`, which moves
 * the application to §8.1's `interview` stage inside the transaction that writes the
 * interview. Scheduling an interview and reaching that stage are one event, and the stage
 * machine - with its BR-08 history row - stays in the module that owns it rather than
 * being reimplemented here.
 */
@Module({
  imports: [ApplicationsModule],
  controllers: [InterviewsController],
  providers: [InterviewsService],
})
export class InterviewsModule {}
