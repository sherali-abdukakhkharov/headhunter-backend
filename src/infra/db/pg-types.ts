import { types } from 'pg';

/** Postgres `date` (OID 1082). */
const DATE_OID = 1082;

/**
 * Makes a calendar date come back as `'YYYY-MM-DD'` rather than a `Date`.
 *
 * node-postgres parses a `date` column into `new Date(y, m - 1, d)` - **local**
 * midnight on the server. That is a value with a time and a zone standing in for
 * one that has neither, and every subsequent formatting choice can shift the day:
 * reading it with UTC getters, or through `formatWithOffset` for
 * `Asia/Tashkent`, moves a birth date or an availability date by one day
 * whenever the server's zone and the platform zone disagree. It looks correct on
 * a machine configured for Tashkent and wrong in production.
 *
 * A calendar date has no instant, so it is a string end to end: `'2026-08-12'` is
 * what Postgres stores, what this returns, and what API_CONTRACTS.md §4.2 puts on
 * the wire for `kind: "date"`. No conversion, nothing to get wrong.
 *
 * The generated types agree because `pnpm kysely:generate` runs with
 * `--date-parser string`; the two settings are a pair and changing one alone
 * makes the types lie about the runtime.
 *
 * `timestamptz` is deliberately untouched: an instant *is* a point in time, and
 * `formatWithOffset` renders it for the platform zone (§2).
 */
export function configurePgTypeParsers(): void {
  types.setTypeParser(DATE_OID, (value: string) => value);
}
