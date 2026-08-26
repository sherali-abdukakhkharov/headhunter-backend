import { type RawBuilder, sql } from 'kysely';

/**
 * The name §10.2 shows for an account, in the order the account itself would answer.
 *
 * One expression, three callers — the user list, the user detail and the audit log —
 * because two copies drifting is one person shown under two names depending on which
 * screen you opened.
 *
 * `u.full_name` is **last**. A profile name is the one the person maintains and the one
 * their counterpart sees; `users.full_name` is what the deployment was told through
 * `SEED_ADMIN_PHONES`, and it exists because an administrator has no profile to ask.
 *
 * Assumes the aliases `u`, `cp`, `e` and `c` are in scope, which is why anything
 * resolving a name for an id it does not already join uses [displayNameFor] instead of
 * arranging the joins itself.
 */
export const DISPLAY_NAME = sql`COALESCE(cp.full_name, c.public_name, e.full_name, u.full_name)`;

/**
 * [DISPLAY_NAME] for one id, as a scalar subquery.
 *
 * For a query that needs a name but has no business joining four tables to get it - the
 * audit log, whose own row is what it is really selecting. Four primary-key lookups per
 * row against a page of twenty, so the cost is not the reason to prefer the join form;
 * *filtering* is. A caller that has to search by name needs the joins.
 *
 * Null for an id that names nobody, which includes the id being null: the log carries a
 * `target_id` for four target types that are not users at all.
 */
export function displayNameFor(
  userId: RawBuilder<unknown>,
): RawBuilder<string | null> {
  return sql`(
    SELECT ${DISPLAY_NAME}
    FROM users u
    LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
    LEFT JOIN employers e ON e.user_id = u.id
    LEFT JOIN companies c ON c.employer_user_id = u.id
    WHERE u.id = ${userId}
  )`;
}
