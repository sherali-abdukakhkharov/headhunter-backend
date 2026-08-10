import { Injectable, Logger } from '@nestjs/common';

import { maskPhone } from '@infra/phone/phone';

import { type SmsMessage, type SmsResult, SmsSender } from './sms-sender';

/**
 * The sender used while no Eskiz account is configured.
 *
 * It reports **`failed`, never `sent`** - the same rule `NoopPushSender` follows. A no-op
 * that claimed success would put "delivered" in the logs for a code nobody received, and
 * would train everyone to believe delivery works.
 *
 * That looks harsher than it is, because on this path nothing is lost: `OTP_STATIC_CODE`
 * fixes the code and `OTP_ECHO_IN_RESPONSE` returns it, so a developer still logs in. What
 * changes is that the *server* stops pretending, and `OtpService` treats a failed send as
 * a failed send - which is exactly the behaviour we want exercised before a real provider
 * ever fails.
 *
 * It logs the masked number and never the code (§12.1).
 */
@Injectable()
export class LoggingSmsSender extends SmsSender {
  private readonly logger = new Logger(LoggingSmsSender.name);

  // Not `async`: there is nothing to await, and the interface asks for a promise rather
  // than for asynchrony.
  send(message: SmsMessage): Promise<SmsResult> {
    this.logger.warn(
      `SMS not configured: nothing sent to ${maskPhone(message.phone)} ` +
        `(${message.locale}, ${message.text.length} chars). ` +
        'Set ESKIZ_EMAIL and ESKIZ_PASSWORD to enable delivery.',
    );

    return Promise.resolve({ status: 'failed', error: 'sms_not_configured' });
  }
}
