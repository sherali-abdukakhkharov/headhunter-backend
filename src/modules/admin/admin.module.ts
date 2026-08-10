import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { EmployersModule } from '@modules/employers/employers.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { VacanciesModule } from '@modules/vacancies/vacancies.module';

import { AdminController } from './admin.controller';
import { AuditService } from './audit.service';
import { DashboardService } from './dashboard.service';
import { DictionaryAdminService } from './dictionary-admin.service';
import { AdminModerationService } from './moderation.service';
import { RetentionService } from './retention.service';
import { AdminUsersService } from './users-admin.service';

/**
 * §10's administration (M10).
 *
 * The module that finally gives the two MVP flags somebody to switch them on for:
 * `EMPLOYER_VERIFICATION_ENABLED` and `MODERATION_ENABLED` were off because nobody could
 * approve anything, and BR-12's restricted vacancies have been waiting for a reviewer since
 * M5. Both decision machines already existed - M4's `VerificationService.decide` and M5's
 * `VacanciesService.moderate`, each with its transitions, mandatory reasons and BR-08
 * history rows - so what this module adds is the queue, the actor and the audit row.
 *
 * `EmployersModule` and `VacanciesModule` are imported for exactly those two methods.
 * Nothing here re-implements a rule that lives in the module that owns the aggregate.
 */
@Module({
  imports: [EmployersModule, VacanciesModule, FilesModule, NotificationsModule],
  controllers: [AdminController],
  providers: [
    AuditService,
    DashboardService,
    AdminModerationService,
    AdminUsersService,
    DictionaryAdminService,
    RetentionService,
  ],
})
export class AdminModule {}
