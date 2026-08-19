import {
  dayBoundsInZone,
  formatDateOnly,
  formatWithOffset,
  offsetMinutes,
} from './format';

describe('formatWithOffset', () => {
  it('renders the platform zone with an explicit offset', () => {
    // The example frozen in docs/API_CONTRACTS.md §2.
    expect(
      formatWithOffset(new Date('2026-08-12T09:00:00Z'), 'Asia/Tashkent'),
    ).toBe('2026-08-12T14:00:00+05:00');
  });

  it('never emits Z, even for UTC itself', () => {
    // The whole point of the contract: Dart's DateTime.parse discards an offset
    // and re-renders in the device zone, so `Z` would silently shift every
    // displayed time. UTC must serialize as +00:00.
    const formatted = formatWithOffset(new Date('2026-08-12T09:00:00Z'), 'UTC');
    expect(formatted).toBe('2026-08-12T09:00:00+00:00');
    expect(formatted).not.toContain('Z');
  });

  it('is DST-correct: the same zone yields different offsets across the year', () => {
    // Asia/Tashkent has no DST today, so prove the mechanism against a zone
    // that does. If Uzbekistan reintroduces DST this keeps working untouched.
    const winter = formatWithOffset(
      new Date('2026-01-15T17:00:00Z'),
      'America/New_York',
    );
    const summer = formatWithOffset(
      new Date('2026-07-15T17:00:00Z'),
      'America/New_York',
    );

    expect(winter).toBe('2026-01-15T12:00:00-05:00');
    expect(summer).toBe('2026-07-15T13:00:00-04:00');
  });

  it('handles a zone with a half-hour offset', () => {
    expect(
      formatWithOffset(new Date('2026-08-12T09:00:00Z'), 'Asia/Kolkata'),
    ).toBe('2026-08-12T14:30:00+05:30');
  });

  it('renders midnight as 00, not 24', () => {
    // Some Intl implementations report hour 24 for midnight with hour12: false.
    expect(
      formatWithOffset(new Date('2026-08-11T19:00:00Z'), 'Asia/Tashkent'),
    ).toBe('2026-08-12T00:00:00+05:00');
  });

  it('includes milliseconds only when non-zero', () => {
    expect(
      formatWithOffset(new Date('2026-08-12T09:00:00.250Z'), 'Asia/Tashkent'),
    ).toBe('2026-08-12T14:00:00.250+05:00');
    expect(
      formatWithOffset(new Date('2026-08-12T09:00:00.000Z'), 'Asia/Tashkent'),
    ).toBe('2026-08-12T14:00:00+05:00');
  });

  it('round-trips back to the same instant', () => {
    // The client reads wall-clock components off the string, but anything that
    // parses the whole value must still land on the original instant.
    const instant = new Date('2026-08-12T09:00:00Z');
    for (const zone of ['Asia/Tashkent', 'UTC', 'America/New_York']) {
      expect(new Date(formatWithOffset(instant, zone)).getTime()).toBe(
        instant.getTime(),
      );
    }
  });
});

describe('offsetMinutes', () => {
  it('returns minutes east of UTC', () => {
    const instant = new Date('2026-08-12T09:00:00Z');
    expect(offsetMinutes(instant, 'Asia/Tashkent')).toBe(300);
    expect(offsetMinutes(instant, 'UTC')).toBe(0);
    expect(offsetMinutes(instant, 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutes(instant, 'America/New_York')).toBe(-240);
  });
});

describe('dayBoundsInZone', () => {
  it('bounds the Tashkent calendar day, not the UTC one', () => {
    // Midday in Tashkent, so both zones agree on the date and the naive answer looks right.
    const bounds = dayBoundsInZone(
      new Date('2026-08-19T07:00:00Z'),
      'Asia/Tashkent',
    );

    expect(bounds.start.toISOString()).toBe('2026-08-18T19:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-08-19T19:00:00.000Z');
  });

  it('is on the right day during the five hours UTC disagrees', () => {
    // **The case every machine on this project hides.** 21:00 UTC on the 19th is already
    // 02:00 on the 20th in Tashkent, so a counter keyed on the UTC date would still be
    // counting the previous day - and a daily quota would reset five hours late.
    const late = new Date('2026-08-19T21:00:00Z');

    expect(formatDateOnly(late, 'Asia/Tashkent')).toBe('2026-08-20');
    expect(dayBoundsInZone(late, 'Asia/Tashkent').start.toISOString()).toBe(
      '2026-08-19T19:00:00.000Z',
    );
    // `setUTCHours(0, 0, 0, 0)` would have said this, five hours too early:
    expect(dayBoundsInZone(late, 'Asia/Tashkent').start.toISOString()).not.toBe(
      '2026-08-19T00:00:00.000Z',
    );
  });

  it('spans exactly 24 hours in a zone without DST', () => {
    const { start, end } = dayBoundsInZone(
      new Date('2026-08-19T07:00:00Z'),
      'Asia/Tashkent',
    );

    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('follows the wall clock across a DST boundary', () => {
    // Uzbekistan has no DST, so this is about the helper not being quietly wrong if the zone
    // is ever configured elsewhere. 2026-03-29 is when the EU springs forward, and that day
    // is 23 hours long - a naive "+86 400 000" would land at 01:00 rather than midnight.
    const { start, end } = dayBoundsInZone(
      new Date('2026-03-29T10:00:00Z'),
      'Europe/Berlin',
    );

    expect(formatWithOffset(start, 'Europe/Berlin')).toBe(
      '2026-03-29T00:00:00+01:00',
    );
    expect(formatWithOffset(end, 'Europe/Berlin')).toBe(
      '2026-03-30T00:00:00+02:00',
    );
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('rolls over a month and a year boundary', () => {
    expect(
      dayBoundsInZone(
        new Date('2026-12-31T19:30:00Z'),
        'Asia/Tashkent',
      ).end.toISOString(),
    ).toBe('2027-01-01T19:00:00.000Z');
  });
});
