import {
  dayBoundsInZone,
  endOfDayInZone,
  formatDateOnly,
  formatRowTimestamps,
  formatWithOffset,
  offsetMinutes,
  startOfDayInZone,
} from './format';

describe('startOfDayInZone / endOfDayInZone', () => {
  it('resolves a calendar date to the platform zone, not to UTC', () => {
    // Midnight in Tashkent is 19:00 the previous day in UTC. This is the whole difference
    // between these helpers and a `::date` cast in SQL, which resolves in the *session*
    // zone - UTC on this deployment, so five hours late.
    expect(startOfDayInZone('2026-08-01', 'Asia/Tashkent').toISOString()).toBe(
      '2026-07-31T19:00:00.000Z',
    );
    expect(endOfDayInZone('2026-08-07', 'Asia/Tashkent').toISOString()).toBe(
      '2026-08-07T19:00:00.000Z',
    );
  });

  it('puts an 02:00 Tashkent registration in its own day, which SQL casting did not', () => {
    // The bug these exist for, as a property. Somebody who registered at 02:00 on the 1st
    // was excluded from a period starting on the 1st and included in one ending on the
    // 31st, because '2026-08-01'::date meant 05:00 Tashkent.
    const registered = new Date('2026-08-01T02:00:00+05:00');

    const august = {
      start: startOfDayInZone('2026-08-01', 'Asia/Tashkent'),
      end: endOfDayInZone('2026-08-31', 'Asia/Tashkent'),
    };
    const july = {
      start: startOfDayInZone('2026-07-01', 'Asia/Tashkent'),
      end: endOfDayInZone('2026-07-31', 'Asia/Tashkent'),
    };

    expect(registered >= august.start && registered < august.end).toBe(true);
    expect(registered >= july.start && registered < july.end).toBe(false);

    // And what the old SQL cast did with the same instant, for the record.
    expect(registered >= new Date('2026-08-01T00:00:00Z')).toBe(false);
  });

  it('is inclusive of the end date, which is what picking "1st to 7th" means', () => {
    const lateOnTheSeventh = new Date('2026-08-07T23:30:00+05:00');

    expect(
      lateOnTheSeventh < endOfDayInZone('2026-08-07', 'Asia/Tashkent'),
    ).toBe(true);
  });

  it('follows the wall clock across a DST boundary', () => {
    // Uzbekistan has no DST; this is about the helpers not becoming quietly wrong if the
    // zone is ever configured somewhere that does. 2026-03-29 is 23 hours long in Berlin.
    const start = startOfDayInZone('2026-03-29', 'Europe/Berlin');
    const end = endOfDayInZone('2026-03-29', 'Europe/Berlin');

    expect(formatWithOffset(start, 'Europe/Berlin')).toBe(
      '2026-03-29T00:00:00+01:00',
    );
    expect(formatWithOffset(end, 'Europe/Berlin')).toBe(
      '2026-03-30T00:00:00+02:00',
    );
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('refuses anything that is not a calendar date', () => {
    // Without this the string reaches Intl as a NaN date and surfaces as
    // `RangeError: Invalid time value` from inside the formatter, which says nothing about
    // where the bad value came from. Every route validates the shape first, so this is a
    // programming-error guard - and §12.5's injection test relies on it.
    expect(() => startOfDayInZone('2026-8-1', 'Asia/Tashkent')).toThrow(
      RangeError,
    );
    expect(() => startOfDayInZone('yesterday', 'Asia/Tashkent')).toThrow(
      /Not a calendar date/,
    );
    expect(() => endOfDayInZone('', 'Asia/Tashkent')).toThrow(RangeError);
  });
});

describe('formatRowTimestamps', () => {
  it('renders every instant in a row, which is the point of doing it by type', () => {
    // The shape that made this necessary: `VacancyReviewDto.vacancy` is the vacancies row,
    // and it carries four timestamptz columns. A per-field call at the boundary has to be
    // kept in step with a `select()` in another file, and the one that is forgotten ships
    // a `Z` - which is what `ComplaintDetailDto.target.created_at` did.
    const row = {
      id: 'v1',
      published_at: new Date('2026-08-12T09:00:00Z'),
      closed_at: null,
      created_at: new Date('2026-08-01T19:30:00Z'),
      updated_at: new Date('2026-08-12T09:00:00Z'),
    };

    expect(formatRowTimestamps(row, 'Asia/Tashkent')).toEqual({
      id: 'v1',
      published_at: '2026-08-12T14:00:00+05:00',
      closed_at: null,
      created_at: '2026-08-02T00:30:00+05:00',
      updated_at: '2026-08-12T14:00:00+05:00',
    });
  });

  it('leaves a calendar date alone, which is what makes the type test safe', () => {
    // `date` columns are strings end to end in this codebase (`--date-parser string`), so a
    // Date instance is always an instant. If that ever changed, `starts_on` would come back
    // as a Date and this helper would render a deadline as a timestamp - so assert it.
    const row = {
      starts_on: '2026-09-01',
      ends_on: null,
      deadline_on: '2026-08-25',
      worker_count: 3,
      salary_is_negotiable: false,
      salary_from: '5000000.00',
    };

    expect(formatRowTimestamps(row, 'Asia/Tashkent')).toEqual(row);
  });

  it('does not walk into a nested object', () => {
    // Shallow on purpose: the audit log's `details` is jsonb, and reformatting whatever a
    // caller stored in it is not this function's business. That bag is fixed where it is
    // written instead.
    const nested = { at: new Date('2026-08-12T09:00:00Z') };

    expect(formatRowTimestamps({ details: nested }, 'Asia/Tashkent')).toEqual({
      details: nested,
    });
  });
});

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
