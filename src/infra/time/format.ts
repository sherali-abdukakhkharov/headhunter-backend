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
