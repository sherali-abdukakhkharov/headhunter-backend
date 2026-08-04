import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import {
  BadRequestError,
  ForbiddenError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  AccountStatus,
  LocaleCode,
  UserRole,
} from '@infra/db/database.types';

import type { DeviceInfo } from './session.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  roles: UserRole[];
  activeRole: UserRole | null;
  /** True when this verification created the account, so the client can route
   *  into onboarding (role selection) rather than the home screen. */
  isNewUser: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Finds, links or creates the account behind a verified Telegram identity and
   * opens a session.
   *
   * The MVP login path (client direction, 2026-08-05). Like the phone flow,
   * registration and login are the same call - the client cannot know which one it
   * is performing, and asking it to would create a way to probe which Telegram
   * accounts are registered.
   *
   * Three cases, resolved in this order inside one transaction:
   *
   * 1. **Known Telegram id** - sign in. A phone that arrived with the token is
   *    written back, so granting the `phone` scope later fills it in.
   * 2. **Unknown Telegram id, but the verified phone matches an account** - link.
   *    This is what makes the switch from OTP survivable: an account created by the
   *    old flow, or by a support import, is claimed by its owner rather than
   *    duplicated. Safe *only* because `TelegramOidcService` has already refused
   *    any phone Telegram did not mark verified.
   * 3. **Neither** - create.
   */
  async completeTelegramLogin(
    identity: {
      telegramUserId: string;
      username: string | null;
      verifiedPhone: string | null;
    },
    locale: LocaleCode,
    device: DeviceInfo,
  ): Promise<AuthTokens> {
    const { userId, isNewUser, roles } = await this.db
      .transaction()
      .execute(async (trx) => {
        const byTelegram = await trx
          .selectFrom('users')
          .select(['id', 'status'])
          .where('telegram_user_id', '=', identity.telegramUserId)
          .executeTakeFirst();

        if (byTelegram) {
          assertNotBlocked(byTelegram.status);

          await trx
            .updateTable('users')
            .set({
              telegram_username: identity.username,
              // Only ever fills a gap. Overwriting a phone already on the account
              // would let a changed Telegram number silently move an identity that
              // other records - and BR-09's contact rule - point at.
              ...(identity.verifiedPhone
                ? { phone: sql`COALESCE(phone, ${identity.verifiedPhone})` }
                : {}),
              last_login_at: new Date(),
              updated_at: new Date(),
            })
            .where('id', '=', byTelegram.id)
            .execute();

          return {
            userId: byTelegram.id,
            isNewUser: false,
            roles: await rolesIn(trx, byTelegram.id),
          };
        }

        // Whether this phone is already on an account decides both branches below,
        // so it is one lookup rather than two.
        const phoneHolder = identity.verifiedPhone
          ? await trx
              .selectFrom('users')
              .select(['id', 'status', 'telegram_user_id'])
              .where('phone', '=', identity.verifiedPhone)
              .executeTakeFirst()
          : undefined;

        if (phoneHolder) {
          // A row already claimed by a *different* Telegram account is not ours to
          // take over. Realistic here rather than theoretical: mobile numbers get
          // recycled, so the new owner of a number can genuinely turn up holding a
          // Telegram account of their own.
          const byPhone =
            phoneHolder.telegram_user_id === null ? phoneHolder : undefined;

          if (byPhone) {
            assertNotBlocked(byPhone.status);

            await trx
              .updateTable('users')
              .set({
                telegram_user_id: identity.telegramUserId,
                telegram_username: identity.username,
                last_login_at: new Date(),
                updated_at: new Date(),
              })
              .where('id', '=', byPhone.id)
              .execute();

            // BR-08: linking a second credential to an existing account is a
            // security-relevant change to it, so it leaves a trail even though the
            // status did not move.
            await trx
              .insertInto('account_status_history')
              .values({
                user_id: byPhone.id,
                from_status: byPhone.status,
                to_status: byPhone.status,
                actor_user_id: byPhone.id,
                reason: 'telegram_account_linked',
              })
              .execute();

            return {
              userId: byPhone.id,
              isNewUser: false,
              roles: await rolesIn(trx, byPhone.id),
            };
          }
        }

        const created = await trx
          .insertInto('users')
          .values({
            telegram_user_id: identity.telegramUserId,
            telegram_username: identity.username,
            // Left null when another account already holds this number. The phone
            // is unique, so writing it here would fail the insert and turn a
            // recycled number into a 500 on somebody's first login.
            phone: phoneHolder ? null : identity.verifiedPhone,
            locale,
            last_login_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // BR-08: the account's status history starts at creation, so the audit
        // trail has no gap before the first admin action.
        await trx
          .insertInto('account_status_history')
          .values({
            user_id: created.id,
            from_status: null,
            to_status: 'active',
            reason: 'registration_telegram',
          })
          .execute();

        // Roles are chosen after registration (§4.1 onboarding), so a new account
        // deliberately holds none yet.
        return { userId: created.id, isNewUser: true, roles: [] as UserRole[] };
      });

    return this.issueTokens(userId, roles, device, isNewUser);
  }

  /**
   * Finds or creates the account behind a verified phone number and opens a
   * session.
   *
   * Registration and login are the same call because they are the same act with
   * a phone-only identity (§4.1): the client cannot know which one it is doing,
   * and asking it to would create a way to probe which numbers are registered.
   *
   * **Reachable only when `OTP_LOGIN_ENABLED` is on.** Telegram is the MVP login
   * path; this is kept whole, with its tests, because §4.1 still specifies it.
   */
  async completePhoneVerification(
    phone: string,
    locale: LocaleCode,
    device: DeviceInfo,
  ): Promise<AuthTokens> {
    const { userId, isNewUser, roles } = await this.db
      .transaction()
      .execute(async (trx) => {
        const existing = await trx
          .selectFrom('users')
          .select(['id', 'status'])
          .where('phone', '=', phone)
          .executeTakeFirst();

        if (existing) {
          // BR-10: a blocked account cannot authenticate at all, not merely fail
          // its mutations.
          if (existing.status === 'blocked') {
            throw new ForbiddenError('account.blocked');
          }

          await trx
            .updateTable('users')
            .set({ last_login_at: new Date(), updated_at: new Date() })
            .where('id', '=', existing.id)
            .execute();

          const roleRows = await trx
            .selectFrom('user_roles')
            .select('role')
            .where('user_id', '=', existing.id)
            .execute();

          return {
            userId: existing.id,
            isNewUser: false,
            roles: roleRows.map((r) => r.role),
          };
        }

        const created = await trx
          .insertInto('users')
          .values({ phone, locale, last_login_at: new Date() })
          .returning('id')
          .executeTakeFirstOrThrow();

        // BR-08: the account's status history starts at creation, so the audit
        // trail has no gap before the first admin action.
        await trx
          .insertInto('account_status_history')
          .values({
            user_id: created.id,
            from_status: null,
            to_status: 'active',
            reason: 'registration',
          })
          .execute();

        // Roles are chosen after registration (§4.1 onboarding), so a new
        // account deliberately holds none yet.
        return { userId: created.id, isNewUser: true, roles: [] as UserRole[] };
      });

    return this.issueTokens(userId, roles, device, isNewUser);
  }

  /** Refresh with rotation; reuse detection lives in `SessionService.rotate`. */
  async refresh(refreshToken: string, device: DeviceInfo): Promise<AuthTokens> {
    const { session, userId } = await this.sessions.rotate(
      refreshToken,
      device,
    );
    const roles = await this.sessions.rolesFor(userId);

    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      roles,
      activeRole: defaultActiveRole(roles),
      sid: session.sessionId,
    });

    return {
      accessToken,
      refreshToken: session.refreshToken,
      expiresInSeconds: this.tokens.expiresInSeconds,
      roles,
      activeRole: defaultActiveRole(roles),
      isNewUser: false,
    };
  }

  /**
   * Records the roles chosen at the end of registration (§2.3).
   *
   * `admin` is never self-assignable - it is granted by an existing
   * administrator in M10. Accepting it here would be a privilege-escalation
   * endpoint.
   */
  async selectRoles(userId: string, roles: UserRole[]): Promise<UserRole[]> {
    if (roles.length === 0) {
      throw new BadRequestError('role.at_least_one_required');
    }

    if (roles.includes('admin')) {
      throw new ForbiddenError('role.admin_not_self_assignable');
    }

    const unique = [...new Set(roles)];

    await this.db
      .insertInto('user_roles')
      .values(unique.map((role) => ({ user_id: userId, role })))
      // Re-running onboarding must not fail on a role the user already holds.
      .onConflict((oc) => oc.columns(['user_id', 'role']).doNothing())
      .execute();

    return this.sessions.rolesFor(userId);
  }

  /**
   * Switches the active role.
   *
   * The requested role is checked against what is actually granted, in the
   * database rather than against the token's own claim list - a client that
   * forged or replayed a stale token must not be able to widen its own access.
   */
  async switchActiveRole(
    userId: string,
    sessionId: string,
    role: UserRole,
  ): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const roles = await this.sessions.rolesFor(userId);

    if (!roles.includes(role)) {
      throw new ForbiddenError('role.not_granted');
    }

    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      roles,
      activeRole: role,
      sid: sessionId,
    });

    return { accessToken, expiresInSeconds: this.tokens.expiresInSeconds };
  }

  private async issueTokens(
    userId: string,
    roles: UserRole[],
    device: DeviceInfo,
    isNewUser: boolean,
  ): Promise<AuthTokens> {
    const session = await this.sessions.issue(userId, device);
    const activeRole = defaultActiveRole(roles);

    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      roles,
      activeRole,
      sid: session.sessionId,
    });

    return {
      accessToken,
      refreshToken: session.refreshToken,
      expiresInSeconds: this.tokens.expiresInSeconds,
      roles,
      activeRole,
      isNewUser,
    };
  }
}

/** BR-10: a blocked account cannot authenticate at all, not merely fail its
 *  mutations. Shared by both login paths so neither can forget it. */
function assertNotBlocked(status: AccountStatus): void {
  if (status === 'blocked') {
    throw new ForbiddenError('account.blocked');
  }
}

async function rolesIn(trx: Database, userId: string): Promise<UserRole[]> {
  const rows = await trx
    .selectFrom('user_roles')
    .select('role')
    .where('user_id', '=', userId)
    .execute();

  return rows.map((row) => row.role);
}

/**
 * The role a fresh token acts as.
 *
 * A single-role account has no choice to make, so picking it saves the client a
 * round trip. A multi-role account gets `null` and must choose explicitly -
 * guessing would silently decide which permissions the session starts with.
 */
export function defaultActiveRole(roles: UserRole[]): UserRole | null {
  return roles.length === 1 ? roles[0] : null;
}
