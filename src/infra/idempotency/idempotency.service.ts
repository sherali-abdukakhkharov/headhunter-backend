import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { ConflictError } from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';

/**
 * How old an unfinished claim must be before another attempt may take it over.
 *
 * Past this, no client is still waiting for the attempt that made it: Cloudflare, in
 * front of the API, gives up on an origin after 100 seconds and answers 524. Every
 * operation guarded here is one short transaction, so a claim this old with no result
 * belongs to a process that died between claiming and recording.
 */
export const ABANDONED_CLAIM_SECONDS = 120;

/**
 * `Idempotency-Key` handling (ARCHITECTURE.md §7, §12.4).
 *
 * §12.4 requires "safe retry without duplicate application, invitation, or message
 * creation". Mobile clients retry - assume it - and the dangerous case is the request
 * that *succeeded* and whose response was lost: the client cannot tell that from a
 * failure, so it sends the same thing again.
 *
 * This is deliberately **separate from BR-07's unique index**, and both are needed:
 *
 * - The index prevents a logical duplicate. It answers a retry with a constraint
 *   violation, which the client cannot distinguish from "somebody else got there
 *   first".
 * - The key makes an interrupted-but-committed request *replayable*: the same key with
 *   the same request returns the original resource, so a retry looks like a success
 *   because it was one.
 *
 * A different request under the same key is the client's bug and answers `409`. Not a
 * silent overwrite and not a second resource: if a key means "this one operation", two
 * different operations under it means the client's key generation is broken, and saying
 * so is more useful than guessing which it meant.
 *
 * **A key is held only by an attempt that is running or that succeeded.** Until
 * 2026-09-23 a refused attempt kept its claim: a new candidate tapped Apply before
 * filling in a profile, was told `candidate.profile_required`, filled it in - and every
 * retry after that answered `idempotency.in_progress`, indefinitely, because the app
 * keeps the key until it sees a success (§12.4 requires it to) and the claim of the
 * refused attempt never recorded one. Every operation guarded here refuses *after* its
 * transaction has rolled back, so a throw from `work` means nothing was written and the
 * key is free again. A claim abandoned by a crash is the one case a throw cannot
 * release, and that is what the takeover is for.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /**
   * Runs `operation` at most once per key.
   *
   * Returns the resource id, whether this call created it or an earlier one did.
   *
   * The claim is inserted **before** the work runs, so two concurrent retries cannot
   * both pass the check - the second finds the first's claim and is told the request
   * is in progress. That ordering is the whole mechanism; checking first and inserting
   * afterwards would leave exactly the window this exists to close.
   */
  async run(
    key: string | undefined,
    userId: string,
    operation: string,
    request: unknown,
    work: () => Promise<string>,
  ): Promise<string> {
    // No key means the client has not opted in, so there is nothing to replay. The
    // header is optional by design: BR-07 still prevents a logical duplicate.
    if (!key) {
      return work();
    }

    const claim = {
      key,
      userId,
      operation,
      fingerprint: fingerprintOf(request),
    };

    if (!(await this.claim(claim))) {
      return this.answerExisting(claim);
    }

    let resourceId: string;

    try {
      resourceId = await work();
    } catch (error) {
      await this.release(claim);
      throw error;
    }

    await this.db
      .updateTable('idempotency_keys')
      .set({ resource_id: resourceId })
      .where('user_id', '=', userId)
      .where('operation', '=', operation)
      .where('key', '=', key)
      .execute();

    return resourceId;
  }

  /**
   * Takes the key for this attempt: a fresh insert, or the takeover of an abandoned
   * claim for the same request.
   *
   * Both are single statements, so two concurrent attempts cannot both win. The
   * takeover's `UPDATE` re-checks its `WHERE` against the row once it holds the lock,
   * and the winner has just moved `created_at` to now - so the loser matches nothing.
   */
  private async claim(claim: Claim): Promise<boolean> {
    const inserted = await this.db
      .insertInto('idempotency_keys')
      .values({
        key: claim.key,
        user_id: claim.userId,
        operation: claim.operation,
        fingerprint: claim.fingerprint,
      })
      .onConflict((conflict) =>
        conflict.columns(['user_id', 'operation', 'key']).doNothing(),
      )
      .returning('key')
      .executeTakeFirst();

    if (inserted) {
      return true;
    }

    const taken = await this.db
      .updateTable('idempotency_keys')
      .set({ created_at: sql<Date>`now()` })
      .where('user_id', '=', claim.userId)
      .where('operation', '=', claim.operation)
      .where('key', '=', claim.key)
      .where('fingerprint', '=', claim.fingerprint)
      .where('resource_id', 'is', null)
      .where(
        'created_at',
        '<',
        sql<Date>`now() - make_interval(secs => ${ABANDONED_CLAIM_SECONDS})`,
      )
      .returning('key')
      .executeTakeFirst();

    return taken !== undefined;
  }

  /** The key is somebody else's: replay their result, or say why there is none. */
  private async answerExisting(claim: Claim): Promise<string> {
    const existing = await this.db
      .selectFrom('idempotency_keys')
      .select(['fingerprint', 'resource_id'])
      .where('user_id', '=', claim.userId)
      .where('operation', '=', claim.operation)
      .where('key', '=', claim.key)
      .executeTakeFirst();

    if (existing && existing.fingerprint !== claim.fingerprint) {
      throw new ConflictError('idempotency.key_reused');
    }

    if (existing?.resource_id) {
      return existing.resource_id;
    }

    // Still running - or it was refused and released between our claim and this read,
    // in which case the next retry claims the key afresh.
    throw new ConflictError('idempotency.in_progress');
  }

  /**
   * Frees the key after `work` refused, so the next attempt runs rather than being
   * told this one is still in progress.
   *
   * A failure here must not replace the refusal the caller is about to see, so it is
   * logged and swallowed; the claim it failed to delete becomes takeable once
   * abandoned.
   */
  private async release(claim: Claim): Promise<void> {
    try {
      await this.db
        .deleteFrom('idempotency_keys')
        .where('user_id', '=', claim.userId)
        .where('operation', '=', claim.operation)
        .where('key', '=', claim.key)
        .where('resource_id', 'is', null)
        .execute();
    } catch (error) {
      this.logger.warn(
        `Could not release the ${claim.operation} key after a refusal; it frees itself ` +
          `after ${ABANDONED_CLAIM_SECONDS}s. ${String(error)}`,
      );
    }
  }
}

interface Claim {
  key: string;
  userId: string;
  operation: string;
  fingerprint: string;
}

/**
 * A stable hash of the request.
 *
 * Keys are sorted so that two bodies with the same content in a different order are the
 * same request - which they are, in JSON. The hash rather than the body itself keeps
 * request contents out of a table that exists only to recognise repeats.
 */
export function fingerprintOf(request: unknown): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([keyName, item]) =>
        `${JSON.stringify(keyName)}:${stableStringify(item)}`,
    );

  return `{${entries.join(',')}}`;
}
