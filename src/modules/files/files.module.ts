import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import type { AppEnv } from '@infra/env-schema';
import { FilesModule as FilesInfraModule } from '@infra/files/files.module';

import { FilesController } from './files.controller';

/**
 * HTTP surface for the caller's own files (M3 groundwork).
 *
 * Uploads are buffered in memory rather than written to disk: the bytes are
 * forwarded straight to Telegram, so a temp file would only add a cleanup problem
 * and a second place a private document exists. That is only safe because the
 * multer limit below caps the buffer - without it a large upload is an
 * out-of-memory vector.
 */
@Module({
  imports: [
    FilesInfraModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: config.get('FILE_MAX_SIZE_BYTES', { infer: true }),
          // One file per request, and no other file fields: everything here
          // uploads a single document against a single purpose.
          files: 1,
        },
      }),
    }),
  ],
  controllers: [FilesController],
})
export class FilesHttpModule {}
