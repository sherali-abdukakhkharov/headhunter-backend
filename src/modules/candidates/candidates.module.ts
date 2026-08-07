import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { DictionariesModule } from '@modules/dictionaries/dictionaries.module';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasModule } from '@modules/schemas/schemas.module';

import { AttachmentsService } from './attachments.service';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/**
 * Candidate profiles (M3, §5).
 *
 * `FieldValidatorService` is provided here rather than in `SchemasModule` because it
 * is the *write* half of the schema contract: M5's vacancy writes will use the same
 * class against a different definition, and at that point it moves into a shared
 * module - not before, when moving it would be an abstraction with one caller.
 */
@Module({
  imports: [SchemasModule, DictionariesModule, FilesModule],
  controllers: [CandidatesController, HistoryController],
  providers: [
    CandidatesService,
    HistoryService,
    AttachmentsService,
    FieldValidatorService,
  ],
  exports: [CandidatesService],
})
export class CandidatesModule {}
