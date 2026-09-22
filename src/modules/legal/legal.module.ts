import { Module } from '@nestjs/common';

import { LegalController } from './legal.controller';

/** The privacy policy and the account-deletion page, as public HTML. */
@Module({
  controllers: [LegalController],
})
export class LegalModule {}
