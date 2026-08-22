/**
 * Timestamp serialization for client-facing responses.
 *
 * `docs/API_CONTRACTS.md` §2 freezes the wire format: ISO-8601 with an
 * **explicit numeric offset resolved for that instant**, never `Z` and never
 * offsetless.
 *
 * This exists as one function rather than a convention because
 * `Date.prototype.toISOString()` emits `Z`, and the Flutter client reads the
 * wall-clock components straight off the string - `DateTime.parse` discards the
 * offset and `toLocal()` then re-renders in the *device* zone. A single stray
 * `toISOString()` in a DTO would silently shift every displayed interview time
 * for any user outside the platform zone, and would look perfectly correct on
 * every machine we develop on. Route every timestamp through here.
 */

const PART_OPTIONS: Intl.DateTimeFormatOptions = {
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * Formatters are cached per zone: constructing an `Intl.DateTimeFormat` is far
 * more expensive than formatting with one, and serializing a list of rows calls
 * this once per timestamp.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }

  const created = new Intl.DateTimeFormat('en-US', {
    ...PART_OPTIONS,
    timeZone,
  });
  formatters.set(timeZone, created);
  return created;
}

function wallClockParts(date: Date, timeZone: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}

/**
 * Offset of `timeZone` at the given instant, in minutes east of UTC.
 *
 * Derived by reading the wall clock in that zone and treating it as if it were
 * UTC: the difference from the real instant *is* the offset. This is DST-correct
 * by construction, because the wall clock already reflects whichever rule was in
 * force at that instant - which matters if Uzbekistan ever reintroduces DST, and
 * matters today for any other zone this is used with.
 */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = wallClockParts(date, timeZone);

  // Intl renders midnight as hour 24 in some engines; normalize to 0.
  const hour = p.hour === '24' ? '00' : p.hour;

  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(hour),
    Number(p.minute),
    Number(p.second),
    date.getUTCMilliseconds(),
  );

  return Math.round((asIfUtc - date.getTime()) / 60_000);
}

/**
 * The calendar date at `timeZone` for a given instant, as `'YYYY-MM-DD'`.
 *
 * Separate from `formatWithOffset` because a calendar date is not an instant:
 * "today" in Tashkent is the previous UTC day for five hours out of every
 * twenty-four, so `toISOString().slice(0, 10)` gets it wrong every night. Date-only
 * comparisons (a birth date's minimum age, an availability date) must use this.
 */
export function formatDateOnly(date: Date, timeZone: string): string {
  const p = wallClockParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Formats an instant as ISO-8601 with an explicit numeric offset for `timeZone`.
 *
 * ```
 * formatWithOffset(new Date('2026-08-12T09:00:00Z'), 'Asia/Tashkent')
 * // '2026-08-12T14:00:00+05:00'
 * ```
 */
export function formatWithOffset(date: Date, timeZone: string): string {
  const p = wallClockParts(date, timeZone);
  const hour = p.hour === '24' ? '00' : p.hour;

  const total = offsetMinutes(date, timeZone);
  const sign = total < 0 ? '-' : '+';
  const abs = Math.abs(total);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetMins = String(abs % 60).padStart(2, '0');

  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;

  return (
    `${p.year}-${p.month}-${p.day}` +
    `T${hour}:${p.minute}:${p.second}${fraction}` +
    `${sign}${offsetHours}:${offsetMins}`
  );
}

/**
 * A row on its way into a response, with every instant in it rendered per §2.
 *
 * Two admin responses carry the selected **columns** rather than named fields -
 * `VacancyReviewDto.vacancy` is the vacancy as stored and `ComplaintDetailDto.target` is
 * whichever of four rows was reported. A per-field `formatWithOffset` call cannot be kept
 * complete there: the column list lives in a `select()` somewhere else, and the one that is
 * forgotten when a column is added is the one that ships a `Z`.
 *
 * So this converts by **runtime type** instead, which is exactly right in this codebase
 * rather than merely convenient: a calendar date is a `'YYYY-MM-DD'` string end to end
 * (`--date-parser string`, `infra/db/pg-types.ts`), so a `Date` is always an instant and
 * never a date column. Shallow on purpose - a row is flat, and walking further would start
 * rewriting `jsonb` payloads whose contents are not ours to reformat.
 */
export function formatRowTimestamps<T extends object>(
  row: T,
  timeZone: string,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    formatted[key] =
      value instanceof Date ? formatWithOffset(value, timeZone) : value;
  }

  return formatted;
}

/**
 * The instants that bound the calendar day `date` falls in, at `timeZone`.
 *
 * `start` is that day's midnight and `end` is the next one - so a "today" window is
 * `created_at >= start`, and `end` is when a daily counter resets.
 *
 * **A calendar day, not a rolling 24 hours**, and that is a product decision rather than an
 * implementation convenience: "12 left today, resets at midnight" is a sentence an employer
 * can plan around, and "another in 7 hours 22 minutes, then two more at 09:41" is not.
 *
 * Every machine on this project sits at UTC+5, which makes this the most dangerous kind of
 * helper: `new Date().setUTCHours(0, 0, 0, 0)` agrees with it locally and is wrong for the
 * five hours a day when Tashkent and UTC are on different dates. That is the same trap
 * `formatDateOnly` exists for.
 *
 * The offset is read **at the boundary being computed**, not at `date`, so a day that
 * contains a DST transition still starts and ends at its own wall-clock midnight. Uzbekistan
 * has no DST today; the correction costs one extra `offsetMinutes` call and means this does
 * not quietly become wrong if that changes or if the zone is ever configured to somewhere
 * that does.
 */
export function dayBoundsInZone(
  date: Date,
  timeZone: string,
): { start: Date; end: Date } {
  return {
    start: midnightInZone(formatDateOnly(date, timeZone), timeZone),
    end: midnightInZone(
      nextCalendarDate(formatDateOnly(date, timeZone)),
      timeZone,
    ),
  };
}

/** The instant at which `'YYYY-MM-DD'` begins in `timeZone`. */
function midnightInZone(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const asIfUtc = Date.UTC(year, month - 1, date);

  // First guess: treat the wall clock as UTC and subtract the offset there. Then re-read the
  // offset *at the guess* and correct, which matters only across a DST boundary - where the
  // offset at midnight is not the offset at noon.
  const guess = asIfUtc - offsetMinutes(new Date(asIfUtc), timeZone) * 60_000;

  return new Date(asIfUtc - offsetMinutes(new Date(guess), timeZone) * 60_000);
}

/**
 * The day after `'YYYY-MM-DD'`, as `'YYYY-MM-DD'`.
 *
 * Arithmetic on the calendar date rather than on an instant, because "the next day" is a
 * calendar question: adding 86 400 000 milliseconds to a local midnight lands on 23:00 or
 * 01:00 on a DST boundary rather than on the next midnight.
 */
function nextCalendarDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));

  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
