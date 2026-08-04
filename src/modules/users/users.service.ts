import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  AccountStatus,
  LocaleCode,
  UserRole,
} from '@infra/db/database.types';

export interface UserProfile {
  id: string;
  phone: string;
  locale: LocaleCode;
  status: AccountStatus;
  roles: UserRole[];
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async findProfile(userId: string): Promise<UserProfile> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'phone', 'locale', 'status', 'created_at'])
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user) {
      // Reachable with a valid token whose account was purged; the client's
      // correct response is to log out, which a 404 gets across.
      throw new NotFoundException('User not found');
    }

    const roles = await this.db
      .selectFrom('user_roles')
      .select('role')
      .where('user_id', '=', userId)
      .execute();

    return {
      id: user.id,
      phone: user.phone,
      locale: user.locale,
      status: user.status,
      roles: roles.map((r) => r.role),
      createdAt: user.created_at,
    };
  }

  /**
   * Changes the interface language.
   *
   * §3.2: the choice is stored on the user so it is restored on every signed-in
   * device, rather than being local to the install that made the change.
   */
  async updateLocale(userId: string, locale: LocaleCode): Promise<LocaleCode> {
    const updated = await this.db
      .updateTable('users')
      .set({ locale, updated_at: new Date() })
      .where('id', '=', userId)
      .returning('locale')
      .executeTakeFirst();

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.locale;
  }

  /**
   * Opens an account-deletion request (BR-14).
   *
   * No purge date is set: BR-14 defers retention to an approved privacy policy
   * that does not exist yet, and inventing a period here would be a data-
   * protection commitment made by a developer. `purge_after` stays null until
   * that answer arrives.
   */
  async requestDeletion(userId: string, reason: string | null): Promise<Date> {
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'status'])
        .where('id', '=', userId)
        .executeTakeFirst();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const requestedAt = new Date();

      // The partial unique index allows one open request per user, so a
      // double-tap from a flaky connection is refused by the database. Treating
      // the retry as success keeps the client simple.
      await trx
        .insertInto('deletion_requests')
        .values({ user_id: userId, requested_at: requestedAt, reason })
        .onConflict((oc) => oc.doNothing())
        .execute();

      if (user.status !== 'deletion_requested') {
        await trx
          .updateTable('users')
          .set({ status: 'deletion_requested', updated_at: new Date() })
          .where('id', '=', userId)
          .execute();

        // BR-08: no status change without a history row, written in the same
        // transaction as the change itself.
        await trx
          .insertInto('account_status_history')
          .values({
            user_id: userId,
            from_status: user.status,
            to_status: 'deletion_requested',
            actor_user_id: userId,
            reason: reason ?? 'requested by user',
          })
          .execute();
      }

      return requestedAt;
    });
  }
}
