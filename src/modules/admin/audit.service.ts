import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';

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
  dictionaryItemCreated: 'dictionary.item_created',
  dictionaryItemUpdated: 'dictionary.item_updated',
  dictionaryItemDeactivated: 'dictionary.item_deactivated',
  dictionaryItemsMerged: 'dictionary.items_merged',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorUserId: string;
  action: AuditAction;
  targetType: 'user' | 'employer' | 'vacancy' | 'complaint' | 'dictionary_item';
  targetId: string | null;
  reason?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  createdAt: Date;
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
    let query = this.db.selectFrom('admin_audit_log').selectAll();

    if (filters.actorUserId) {
      query = query.where('actor_user_id', '=', filters.actorUserId);
    }

    if (filters.targetType) {
      query = query.where('target_type', '=', filters.targetType);
    }

    if (filters.targetId) {
      query = query.where('target_id', '=', filters.targetId);
    }

    if (filters.action) {
      query = query.where('action', '=', filters.action);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
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
