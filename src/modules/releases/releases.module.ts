import { Module } from '@nestjs/common';

import { ReleaseNotifierService } from './release-notifier.service';

/**
 * Posts each new client release to Telegram (see [ReleaseNotifierService]).
 *
 * No controller: nothing calls into it and nothing should. It is a timer that
 * reads a public GitHub release and writes one Telegram message, and an HTTP
 * route would only add a way to trigger it from outside — which is the inbound
 * surface, and the shared secret, that polling exists to avoid.
 *
 * Off unless `RELEASE_CHAT_ID` is set, so a developer machine and a test
 * database never post anything.
 */
@Module({
  providers: [ReleaseNotifierService],
})
export class ReleasesModule {}
