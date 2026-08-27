import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { EmployersModule } from '@modules/employers/employers.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { VacanciesModule } from '@modules/vacancies/vacancies.module';
import { PaymentsModule } from '@modules/payments/payments.module';
import { WalletModule } from '@modules/wallet/wallet.module';

import { AdminController } from './admin.controller';
import { AuditService } from './audit.service';
import { DashboardService } from './dashboard.service';
import { DictionaryAdminService } from './dictionary-admin.service';
import { AdminModerationService } from './moderation.service';
import { RetentionService } from './retention.service';
import { AdminWalletsService } from './wallets-admin.service';
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
  imports: [
    EmployersModule,
    VacanciesModule,
    FilesModule,
    NotificationsModule,
    // §10.5's wallet views and the audited manual adjustment. The balance arithmetic and
    // the row lock stay in WalletService; this module adds the queue, the actor and the
    // audit row, exactly as it did for M4's and M5's decision machines.
    WalletModule,
    // §10.5's other half: the Payment Order search. Same division — the order
    // machine stays in PaymentOrdersService and this module adds the unscoped
    // read that only an administrator can reach.
    PaymentsModule,
  ],
  controllers: [AdminController],
  providers: [
    AuditService,
    DashboardService,
    AdminModerationService,
    AdminUsersService,
    DictionaryAdminService,
    RetentionService,
    AdminWalletsService,
  ],
})
export class AdminModule {}
