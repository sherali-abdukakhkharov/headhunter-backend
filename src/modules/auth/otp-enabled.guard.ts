import { type CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import type { AppEnv } from '@infra/env-schema';

/**
 * Closes the phone + OTP routes unless `OTP_LOGIN_ENABLED` is on.
 *
 * A **404**, not a 403: a disabled endpoint should be indistinguishable from one
 * that was never built. A 403 advertises that the route exists and is merely turned
 * off, which invites probing for the flag - and an OTP endpoint left reachable is a
 * second, unwatched way into every account.
 *
 * Read per request rather than at module registration, so the flag can be flipped
 * by a restart with no rebuild, and so nothing depends on reading `process.env`
 * before the Joi schema has validated it.
 */
@Injectable()
export class OtpEnabledGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(config: ConfigService<AppEnv, true>) {
    this.enabled = config.get('OTP_LOGIN_ENABLED', { infer: true });
  }

  canActivate(): boolean {
    if (!this.enabled) {
      throw new NotFoundError('error.not_found');
    }

    return true;
  }
}
