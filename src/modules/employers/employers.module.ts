import { Module } from '@nestjs/common';

import { NotificationsModule } from '@modules/notifications/notifications.module';

import { EmployersController } from './employers.controller';
import { EmployersService } from './employers.service';
import { VerificationService } from './verification.service';

/**
 * Employer profiles and verification (M4, §6.1).
 *
 * Both services are exported because BR-03 and §7 are preconditions on routes that
 * live elsewhere: M5's vacancy submit, and M7's candidate search and invitations.
 * They call `EmployersService.gate` / `assertVerified` rather than reading the
 * status themselves - a precondition duplicated across three modules is one that
 * will drift, and the failure mode is an unverified employer reaching candidate
 * contact details.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [EmployersController],
  providers: [EmployersService, VerificationService],
  exports: [EmployersService, VerificationService],
})
export class EmployersModule {}
