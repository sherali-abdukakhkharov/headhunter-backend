import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import { UnauthorizedError } from '@infra/api/exceptions/localized.exception';
import { generateRefreshToken, hashSecret } from '@infra/crypto/hash';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { UserRole } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';

/** Device details the client may attach to a session (§4.2 session list). */
export interface DeviceInfo {
  fingerprint?: string;
  name?: string;
  platform?: string;
  appVersion?: string;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Result of a rotation transaction.
 *
 * Exists so the transaction can commit its family revocation before the caller
 * turns the failure into an exception; see `SessionService.rotate`.
 */
type RotateOutcome =
  | { kind: 'rotated'; session: IssuedSession; userId: string }
  | { kind: 'reuse'; familyId: string }
  | { kind: 'expired' }
  | { kind: 'unknown_token' };

/** One row of the session list (§4.2), in database column naming. */
export interface ActiveSessionRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  app_version: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly pepper: string;
  private readonly refreshTtlDays: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.pepper = config.get('TOKEN_HASH_PEPPER', { infer: true });
    this.refreshTtlDays = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  /**
   * Opens a new session family.
   *
   * The row's id doubles as its `family_id`, which is why the uuid is generated
   * here rather than defaulted by Postgres - it saves a second statement to
   * backfill the family after insert.
   */
  async issue(userId: string, device: DeviceInfo): Promise<IssuedSession> {
    const sessionId = randomUUID();
    return this.insertSession(sessionId, userId, sessionId, device);
  }

  /**
   * Rotates a refresh token.
   *
   * Reuse detection: the presented row is locked, so two concurrent refreshes
   * serialize. The first rotates it; the second then sees a revoked row and
   * revokes **the entire family**, because a refresh token that has already been
   * exchanged is either a replay or a stolen token being raced against its owner
   * (ARCHITECTURE.md §8).
   *
   * The consequence for clients is deliberate and documented: two parallel
   * refreshes log the user out. A mobile client must single-flight refresh.
   *
   * The transaction **returns** an outcome rather than throwing it. Throwing from
   * inside `transaction().execute()` rolls the transaction back, which would undo
   * the family revocation the exception is reporting: reuse detection would log a
   * warning and reject one request while leaving every stolen session live. The
   * failure is reported after the commit.
   */
  async rotate(
    presentedToken: string,
    device: DeviceInfo,
  ): Promise<{ session: IssuedSession; userId: string }> {
    const hash = hashSecret(presentedToken, this.pepper);

    const outcome = await this.db
      .transaction()
      .execute<RotateOutcome>(async (trx) => {
        const existing = await trx
          .selectFrom('sessions')
          .select((eb) => [
            'id',
            'user_id',
            'family_id',
            'revoked_at',
            // Expiry is decided by the database clock, not the app's. The row's
            // `expires_at` was written from a Node timestamp, but comparing it
            // here against `Date.now()` would still let container clock drift
            // move the boundary; `now()` is the one clock every row shares.
            eb(eb.ref('expires_at'), '<=', sql<Date>`now()`).as('is_expired'),
          ])
          .where('refresh_token_hash', '=', hash)
          .forUpdate()
          .executeTakeFirst();

        if (!existing) {
          return { kind: 'unknown_token' };
        }

        if (existing.revoked_at !== null) {
          await trx
            .updateTable('sessions')
            .set({
              revoked_at: sql<Date>`now()`,
              revoked_reason: 'refresh_token_reuse',
            })
            .where('family_id', '=', existing.family_id)
            .where('revoked_at', 'is', null)
            .execute();

          return { kind: 'reuse', familyId: existing.family_id };
        }

        if (existing.is_expired) {
          return { kind: 'expired' };
        }

        const nextId = randomUUID();

        const issued = await this.insertSession(
          nextId,
          existing.user_id,
          existing.family_id,
          device,
          trx,
        );

        await trx
          .updateTable('sessions')
          .set({
            revoked_at: sql<Date>`now()`,
            revoked_reason: 'rotated',
            replaced_by_session_id: nextId,
          })
          .where('id', '=', existing.id)
          .execute();

        return { kind: 'rotated', session: issued, userId: existing.user_id };
      });

    switch (outcome.kind) {
      case 'rotated':
        return { session: outcome.session, userId: outcome.userId };

      case 'reuse':
        // Logged without the token or a phone number (§12.1); the family id is
        // enough to investigate. Logged after the commit, so the message is only
        // written once the revocation is actually durable.
        this.logger.warn(
          `Refresh token reuse detected; revoked session family ${outcome.familyId}`,
        );
        throw new UnauthorizedError('auth.refresh_reused');

      case 'expired':
        throw new UnauthorizedError('auth.refresh_expired');

      default:
        throw new UnauthorizedError('auth.refresh_invalid');
    }
  }

  /** Revokes one session by its refresh token (logout on this device). */
  async revokeByToken(presentedToken: string): Promise<void> {
    const hash = hashSecret(presentedToken, this.pepper);

    // Idempotent by design: logging out twice, or after expiry, is not an error
    // the client can act on.
    await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'logout' })
      .where('refresh_token_hash', '=', hash)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Revokes one session by id, for the owning user only (§4.2). */
  async revokeById(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'revoked_by_user' })
      .where('id', '=', sessionId)
      // Ownership is part of the predicate rather than a prior read: without it
      // this is an authenticated user revoking anyone's session.
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  /** Terminate-all (§4.2). */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  async listActive(userId: string): Promise<ActiveSessionRow[]> {
    return this.db
      .selectFrom('sessions')
      .select([
        'id',
        'device_name',
        'platform',
        'app_version',
        'created_at',
        'last_used_at',
        'expires_at',
      ])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('last_used_at', 'desc')
      .execute();
  }

  /**
   * Confirms a session is still live, for the auth guard.
   *
   * The access token carries `sid` so a revoked session is refused within its
   * own lifetime rather than staying valid until the access token expires -
   * which is what "terminate all" has to mean to be worth having.
   */
  async isActive(sessionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return row !== undefined;
  }

  async touch(sessionId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ last_used_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
  }

  async rolesFor(userId: string): Promise<UserRole[]> {
    const rows = await this.db
      .selectFrom('user_roles')
      .select('role')
      .where('user_id', '=', userId)
      .execute();

    return rows.map((row) => row.role);
  }

  private async insertSession(
    id: string,
    userId: string,
    familyId: string,
    device: DeviceInfo,
    trx?: Database,
  ): Promise<IssuedSession> {
    const executor = trx ?? this.db;
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await executor
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        family_id: familyId,
        refresh_token_hash: hashSecret(refreshToken, this.pepper),
        device_fingerprint: device.fingerprint ?? null,
        device_name: device.name ?? null,
        platform: device.platform ?? null,
        app_version: device.appVersion ?? null,
        expires_at: expiresAt,
      })
      .execute();

    return { sessionId: id, refreshToken, expiresAt };
  }
}
