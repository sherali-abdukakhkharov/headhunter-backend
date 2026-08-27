import { Inject, Injectable } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';

import { displayNameFor } from './display-name';

/**
 * Every administrator action this product records (§10.4, §11.1).
 *
 * A closed list in code over an open text column in the database: the column is text so a
 * new admin capability needs no migration to be auditable, and this constant is what stops
 * a typo becoming a row nobody can query for. Adding an action means adding it here.
 */
export const AUDIT_ACTIONS = {
  verificationDecided: 'employer.verification_decided',
  vacancyModerated: 'vacancy.moderated',
  complaintReviewed: 'complaint.reviewed',
  userWarned: 'user.warned',
  userRestricted: 'user.restricted',
  userBlocked: 'user.blocked',
  userUnblocked: 'user.unblocked',
  restrictionExpired: 'user.restriction_expired',
  /**
   * BR-14's purge. The one action whose target may no longer exist when the row is read -
   * `target_id` is a bare uuid, not a foreign key, which is what makes that possible.
   */
  accountPurged: 'user.purged',
  /**
   * §10.5's manual wallet adjustment - the one route in the product that can create Coins
   * from nothing, so the trail has to outlive the person who used it.
   */
  walletAdjusted: 'wallet.adjusted',
  /**
   * §10.5's Coin price, unlock cost and registration bonus.
   *
   * These were environment variables, which put a price change outside this log
   * entirely — the record of it was a redeploy in somebody's shell history. One
   * entry per setting actually changed, so a screen that submits all three does
   * not read as three decisions.
   */
  pricingChanged: 'platform.pricing_changed',
  dictionaryItemCreated: 'dictionary.item_created',
  dictionaryItemUpdated: 'dictionary.item_updated',
  dictionaryItemDeactivated: 'dictionary.item_deactivated',
  dictionaryItemsMerged: 'dictionary.items_merged',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorUserId: string;
  action: AuditAction;
  targetType:
    | 'user'
    | 'employer'
    | 'vacancy'
    | 'complaint'
    | 'dictionary_item'
    // The one target that is not a row anywhere: a platform setting is named by
    // its key, and `target_id` is a uuid column. The key goes in `details`.
    | 'platform_setting';
  targetId: string | null;
  reason?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  createdAt: Date;

  /**
   * Who the actor is, resolved here rather than by the caller.
   *
   * A uuid is a way in, not a name, and the client had no cheap route to one: a name per
   * distinct actor meant `GET /admin/users/:id` each, which returns a phone number, a
   * status history and a complaint list to obtain a string - and writes a §11.1 access
   * log line every time. A page of names would have cost a page of logged reads of other
   * people's contact details on a screen nobody opened to read them.
   *
   * Null only for an administrator with no name anywhere, which a seeded account can be.
   */
  actorName: string | null;

  /**
   * The same, for the target - and **only when `targetType` is `user`**.
   *
   * The other four target types are not accounts, so there is nothing for this expression
   * to resolve and it answers null. That is not a gap to fill later with a union over four
   * more tables: a vacancy's title and a dictionary item's label are already in
   * `details` where the action that touched them put them.
   */
  targetName: string | null;
}

/**
 * Writes and reads the append-only audit log.
 *
 * **There is no update and no delete method here, and that is not what makes the log
 * immutable** - three triggers on the table are (§10.4). This class having no such method
 * is a property of today's code; the triggers are a property of the data, and they hold
 * against a migration, a manual `psql` session and a future service that forgets.
 *
 * `record` takes a transaction because for most actions the audit row and the change it
 * describes must commit together. Where the change belongs to another module's own
 * transaction - a verification decision, a vacancy moderation - that module has already
 * written its BR-08 history row inside it, so the audit row is written after and its loss
 * would cost an index entry rather than the record of what happened.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /** Inside the caller's transaction, so the row and its change commit together. */
  async record(trx: Transaction<DB>, entry: AuditEntry): Promise<void> {
    await trx.insertInto('admin_audit_log').values(toRow(entry)).execute();
  }

  /** For an action whose change committed in another module's transaction. */
  async recordAfter(entry: AuditEntry): Promise<void> {
    await this.db.insertInto('admin_audit_log').values(toRow(entry)).execute();
  }

  /**
   * §10.4's read: "available to authorized administrators".
   *
   * Filterable by actor or by target, because those are the two questions asked of it -
   * "what has this administrator done" and "what was done to this user". Newest first,
   * paged, and capped: an audit log is read a screen at a time.
   */
  async list(
    filters: {
      actorUserId?: string;
      targetType?: AuditEntry['targetType'];
      targetId?: string;
      action?: AuditAction;
    },
    limit: number,
    offset: number,
  ): Promise<AuditRecord[]> {
    // Aliased, because the two name subqueries need to say which `id` they mean.
    let query = this.db
      .selectFrom('admin_audit_log as l')
      .selectAll('l')
      .select([
        displayNameFor(sql`l.actor_user_id`).as('actor_name'),
        // A target that is not a user resolves to nothing, which is the answer.
        sql<string | null>`CASE WHEN l.target_type = 'user'
          THEN ${displayNameFor(sql`l.target_id`)} END`.as('target_name'),
      ]);

    if (filters.actorUserId) {
      query = query.where('l.actor_user_id', '=', filters.actorUserId);
    }

    if (filters.targetType) {
      query = query.where('l.target_type', '=', filters.targetType);
    }

    if (filters.targetId) {
      query = query.where('l.target_id', '=', filters.targetId);
    }

    if (filters.action) {
      query = query.where('l.action', '=', filters.action);
    }

    const rows = await query
      .orderBy('l.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action as AuditAction,
      targetType: row.target_type as AuditEntry['targetType'],
      targetId: row.target_id,
      reason: row.reason,
      details: row.details as Record<string, unknown> | null,
      createdAt: row.created_at,
      actorName: row.actor_name,
      targetName: row.target_name,
    }));
  }
}

function toRow(entry: AuditEntry) {
  return {
    actor_user_id: entry.actorUserId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    reason: entry.reason ?? null,
    details: entry.details === undefined ? null : JSON.stringify(entry.details),
  };
}
