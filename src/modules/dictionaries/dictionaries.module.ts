import { Module } from '@nestjs/common';

import { DictionariesController } from './dictionaries.controller';
import { DictionariesService } from './dictionaries.service';

/**
 * Controlled dictionaries (M2).
 *
 * Exported because everything downstream validates ids against it: candidate
 * profiles (M3), vacancy requirements (M5) and both search modules all need to
 * ask "is this id a real, active item of the right type".
 */
@Module({
  controllers: [DictionariesController],
  providers: [DictionariesService],
  exports: [DictionariesService],
})
export class DictionariesModule {}
