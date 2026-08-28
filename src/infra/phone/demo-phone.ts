/**
 * The reserved number range demo accounts live in.
 *
 * This repository now has four phone namespaces and they must not overlap, because
 * each one is the *only* way its rows can be found again:
 *
 * | Prefix   | Who writes it            | Removed by |
 * |----------|--------------------------|------------|
 * | `+99800` | `load-seed.ts`, perf volume | `pnpm load:clean` |
 * | `+99801` | `demo-seed`, tester accounts | `pnpm seed:demo:clean` |
 * | `+9987`  | integration-test fixtures | never; the suites share a database |
 * | `+9989x` | the old random fixture scheme | never; thousands of rows remain |
 *
 * **Why a `0` prefix is safe and a plausible one is not.** After the country code,
 * Uzbekistan's numbering plan has no destination code beginning with `0`: `0` is the
 * domestic trunk prefix, so `0 90 …` is how a subscriber dials `+998 90 …` from
 * inside the country. There is nothing left for `+99800`/`+99801` to collide with —
 * the number cannot be dialled, cannot be allocated, and cannot receive an SMS.
 *
 * That last clause is the one that matters here. A demo account carries a fixed
 * login code (`demo_accounts`), so if its number could ever belong to a real person,
 * that person would register and find a stranger's fixed code already attached to
 * their account. The reserved range is what makes that impossible rather than
 * unlikely, and `demo_accounts` repeats the rule as a CHECK constraint so it holds
 * even for a row this module did not write.
 *
 * The `+9987` fixture range is a warning worth reading in that light: it *is* a real
 * prefix, and 17 000 rows of it now sit in the shared development database looking
 * exactly like registrations.
 */
export const DEMO_PHONE_PREFIX = '+99801';

/** Whether a number is in the reserved demo range. Normalized input only. */
export function isDemoPhone(phone: string): boolean {
  return phone.startsWith(DEMO_PHONE_PREFIX);
}

/**
 * Builds a demo number from a seven-digit tail.
 *
 * Nine national digits in total (`01` + seven), so the client's sign-in field — which
 * is `maxLength: 9` and digits-only — takes it exactly as typed, and `UzPhone.parse`
 * leaves the leading zero alone because it only strips one from an over-length input.
 * What a tester types is the last nine digits of what this returns.
 */
export function demoPhone(tail: string): string {
  if (!/^\d{7}$/.test(tail)) {
    throw new Error(`Demo phone tail must be seven digits, got "${tail}"`);
  }

  return `${DEMO_PHONE_PREFIX}${tail}`;
}
