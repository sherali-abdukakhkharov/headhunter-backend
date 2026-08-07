import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';

export interface DeviceRegistration {
  token: string;
  platform: 'android' | 'ios';
  appVersion?: string;
}

/**
 * Device token registration (§9.2's push half).
 *
 * Small, and one decision inside it is worth stating: **a token is unique across users,
 * not per user.** Phones are handed on, resold and shared in this market, and FCM's
 * registration token belongs to the app installation rather than to the account. If two
 * accounts could both claim one, the second person would receive the first person's
 * notifications - which for this product means somebody else's interview times and
 * contact details.
 *
 * Registering therefore *moves* a token: the later registration wins, and the earlier
 * owner simply stops receiving push on a device they no longer have.
 */
@Injectable()
export class DevicesService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async register(
    userId: string,
    registration: DeviceRegistration,
  ): Promise<void> {
    await this.db
      .insertInto('device_tokens')
      .values({
        user_id: userId,
        token: registration.token,
        platform: registration.platform,
        app_version: registration.appVersion ?? null,
      })
      .onConflict((oc) =>
        oc.column('token').doUpdateSet({
          user_id: userId,
          platform: registration.platform,
          app_version: registration.appVersion ?? null,
          last_seen_at: sql`now()`,
          // A token that was disabled after an UNREGISTERED answer is live again the
          // moment its device registers it: the app was reinstalled.
          disabled_at: null,
        }),
      )
      .execute();
  }

  /**
   * Sign-out, for this device only.
   *
   * Deleting rather than disabling, unlike the dispatcher's cleanup: this is a person
   * saying "not here any more", and keeping the row would only serve to remember a
   * decision they already made.
   */
  async unregister(userId: string, token: string): Promise<void> {
    await this.db
      .deleteFrom('device_tokens')
      .where('user_id', '=', userId)
      .where('token', '=', token)
      .execute();
  }
}
