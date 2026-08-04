import { Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Identity, locale, account status and deletion requests (ARCHITECTURE.md §2).
 *
 * Separate from `auth`, which owns credentials and sessions: everything here is
 * about the account itself and will keep growing (account status transitions in
 * M10), while auth stays about proving who is calling.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
