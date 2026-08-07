import { Injectable, Logger } from '@nestjs/common';

import { type PushMessage, type PushResult, PushSender } from './push-sender';

/**
 * The sender used while no FCM credential is configured (§9.2).
 *
 * The same move `OTP_STATIC_CODE` makes on the login path, and for the same reason: the
 * product has to be complete and testable before a third-party account exists. What it
 * must **not** do is pretend - so it reports `failed`, never `sent`. A no-op that claimed
 * success would leave `isReadByRecipient`-shaped lies in the logs and, worse, would train
 * everyone to believe delivery works.
 *
 * Nothing downstream breaks either way: the in-app row is written before the dispatch, so
 * an instance with no credential still notifies every user - they simply see it when they
 * open the app rather than on their lock screen.
 *
 * It logs once per dispatch at `warn`, so a deployment that was *supposed* to have a
 * credential announces the omission rather than going quiet.
 */
@Injectable()
export class NoopPushSender extends PushSender {
  private readonly logger = new Logger(NoopPushSender.name);

  // Not `async`: there is nothing to await, and the interface asks for a promise rather
  // than for asynchrony.
  send(messages: PushMessage[]): Promise<PushResult[]> {
    this.logger.warn(
      `Push not configured: ${messages.length} message(s) not sent. ` +
        'Set FCM_SERVICE_ACCOUNT_BASE64 to enable delivery.',
    );

    return Promise.resolve(
      messages.map((message) => ({
        token: message.token,
        status: 'failed' as const,
        error: 'push_not_configured',
      })),
    );
  }
}
