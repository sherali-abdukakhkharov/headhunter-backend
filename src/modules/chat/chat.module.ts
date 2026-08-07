import { Module } from '@nestjs/common';

import { FilesModule } from '@infra/files/files.module';
import { IdempotencyModule } from '@infra/idempotency/idempotency.module';
import { PrivacyModule } from '@infra/privacy/privacy.module';

import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * Gated chat (M8, §9.1).
 *
 * Note what this module does **not** import: neither `applications` nor `invitations`.
 * §9.1's gate is one question - "is there a permitted hiring interaction between these
 * two people" - and `PrivacyModule` answers it for BR-09 already. Importing both domain
 * modules to re-derive it would be a second definition of who may talk to whom, and the
 * two would drift.
 */
@Module({
  imports: [PrivacyModule, FilesModule, IdempotencyModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
