import { Module } from '@nestjs/common';

import { DictionariesModule } from '@modules/dictionaries/dictionaries.module';

import { SchemasController } from './schemas.controller';
import { SchemasService } from './schemas.service';

/**
 * Field schemas (M3, docs/API_CONTRACTS.md §4).
 *
 * Exported because the declaration is not only a response: `candidates` routes
 * every write through it and computes completeness from it (§4.2 rule 3 - the
 * server re-validates against the same schema the client rendered).
 */
@Module({
  imports: [DictionariesModule],
  controllers: [SchemasController],
  providers: [SchemasService],
  exports: [SchemasService],
})
export class SchemasModule {}
