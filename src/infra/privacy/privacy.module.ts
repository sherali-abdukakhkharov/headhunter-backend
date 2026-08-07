import { Module } from '@nestjs/common';

import { HiringInteractionService } from './hiring-interaction.service';

/**
 * BR-09's inputs, shared by everything that needs to know whether two people are in a
 * hiring interaction (§11.1, §9.1).
 *
 * The rule itself stays a pure function in `contact-exposure.ts`; this module supplies the
 * one query that answers its third input. Deliberately dependency-free, so no module can
 * end up in a cycle around it.
 */
@Module({
  providers: [HiringInteractionService],
  exports: [HiringInteractionService],
})
export class PrivacyModule {}
