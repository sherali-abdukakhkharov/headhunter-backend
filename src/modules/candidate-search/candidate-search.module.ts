import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { ApplicationsModule } from '@modules/applications/applications.module';
import { EmployersModule } from '@modules/employers/employers.module';

import { CandidateSearchController } from './candidate-search.controller';
import { CandidateSearchService } from './candidate-search.service';

/**
 * Employer-facing candidate search, saves and shortlists (M7, §7).
 *
 * Deliberately not part of `discovery` (ARCHITECTURE.md §2): the candidate's view of
 * vacancies and the employer's view of candidates are both "search" and share nothing -
 * different authorization, different filters, different ranking.
 *
 * `ApplicationsModule` is imported for `CandidateViewService`, which is §7.3's "View
 * profile" action. That service, not a second copy of it here, is where BR-09 is
 * evaluated: it already gathers the rule's three inputs for §6.5, and a privacy rule with
 * two gatherers is a privacy rule that drifts (ARCHITECTURE.md §8).
 */
@Module({
  imports: [EmployersModule, ApplicationsModule, FilesModule],
  controllers: [CandidateSearchController],
  providers: [CandidateSearchService],
})
export class CandidateSearchModule {}
