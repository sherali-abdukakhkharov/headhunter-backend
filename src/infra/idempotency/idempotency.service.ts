import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ConflictError } from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';

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
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /**
   * Runs `operation` at most once per key.
   *
   * Returns the resource id, whether this call created it or an earlier one did.
   *
   * The claim is inserted **before** the work runs, so two concurrent retries cannot
   * both pass the check - the second gets a conflict on the primary key and waits, then
   * finds the first one's result. That ordering is the whole mechanism; checking first
   * and inserting afterwards would leave exactly the window this exists to close.
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

    const fingerprint = fingerprintOf(request);
    const existing = await this.db
      .selectFrom('idempotency_keys')
      .select(['fingerprint', 'resource_id'])
      .where('user_id', '=', userId)
      .where('operation', '=', operation)
      .where('key', '=', key)
      .executeTakeFirst();

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictError('idempotency.key_reused');
      }

      if (existing.resource_id) {
        return existing.resource_id;
      }

      // Claimed but unfinished: the first attempt died between claiming the key and
      // recording its result. Refusing beats guessing - a retry after this returns the
      // resource if the work did commit, and the client may retry with a fresh key if
      // it did not.
      throw new ConflictError('idempotency.in_progress');
    }

    await this.db
      .insertInto('idempotency_keys')
      .values({
        key,
        user_id: userId,
        operation,
        fingerprint,
      })
      .execute();

    const resourceId = await work();

    await this.db
      .updateTable('idempotency_keys')
      .set({ resource_id: resourceId })
      .where('user_id', '=', userId)
      .where('operation', '=', operation)
      .where('key', '=', key)
      .execute();

    return resourceId;
  }
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
