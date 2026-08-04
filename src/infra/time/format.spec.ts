import { formatWithOffset, offsetMinutes } from './format';

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
