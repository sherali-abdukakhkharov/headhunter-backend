import { Module } from '@nestjs/common';

import { DictionariesModule } from '@modules/dictionaries/dictionaries.module';
import { EmployersModule } from '@modules/employers/employers.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasModule } from '@modules/schemas/schemas.module';

import { VacanciesController } from './vacancies.controller';
import { VacanciesService } from './vacancies.service';

/**
 * Vacancies and their status machine (M5, §6.3, §6.4).
 *
 * Imports `EmployersModule` for BR-03: only a complete, verified employer may create
 * or publish a vacancy, and that rule is one method there rather than a check here.
 *
 * Exported because M6 needs it - discovery reads active vacancies and applications
 * check BR-06 against `isOpenForApplications`, which is defined once in
 * `vacancy-status.ts` so the feed cannot advertise a vacancy the apply route refuses.
 */
@Module({
  imports: [
    SchemasModule,
    DictionariesModule,
    EmployersModule,
    NotificationsModule,
  ],
  controllers: [VacanciesController],
  providers: [VacanciesService, FieldValidatorService],
  exports: [VacanciesService],
})
export class VacanciesModule {}
