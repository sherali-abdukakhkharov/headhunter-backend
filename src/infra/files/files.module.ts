import { Module } from '@nestjs/common';

import { FilesService } from './files.service';
import { TelegramFileClient } from './telegram-file.client';

/**
 * File storage, backed by the Telegram Bot API (ARCHITECTURE.md §9).
 *
 * Lives in `infra` rather than as a feature module because it is a dependency of
 * several features - candidate CVs and certificates (M3), employer verification
 * evidence (M4), chat attachments (M8) - and none of them owns it.
 *
 * Exported so those modules inject `FilesService` and apply their own
 * authorization on top; the service itself only ever permits the owner.
 */
@Module({
  providers: [FilesService, TelegramFileClient],
  exports: [FilesService, TelegramFileClient],
})
export class FilesModule {}
