import { describe, it, expect } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
import { SHOP_TZ, previousBeirutDate, todayInBeirut, todayInBeirutDateRange } from './index';

const HOUR_MS = 60 * 60 * 1000;

function spanHours(date: string): number {
  const { startUtc, endUtc } = todayInBeirutDateRange(date);
  return (endUtc.getTime() - startUtc.getTime()) / HOUR_MS;
}

function local(d: Date): string {
  return formatInTimeZone(d, SHOP_TZ, 'yyyy-MM-dd HH:mm');
}

// Every instant the given Beirut wall clock names on that date must fall
// inside the day's range. That is the property the punch queries depend on.
function covers(date: string, hhmm: string): boolean {
  const { startUtc, endUtc } = todayInBeirutDateRange(date);
  // Walk the real timeline instead of converting the wall-clock string, so a
  // repeated hour is checked at both of the instants it happens at.
  for (let t = startUtc.getTime() - 2 * HOUR_MS; t < endUtc.getTime() + 2 * HOUR_MS; t += 60_000) {
    const at = new Date(t);
    if (local(at) !== `${date} ${hhmm}`) continue;
    if (t < startUtc.getTime() || t >= endUtc.getTime()) return false;
  }
  return true;
}

describe('time package placeholder', () => {
  it('exports SHOP_TZ constant', () => {
    expect(SHOP_TZ).toBe('Asia/Beirut');
  });

  it('todayInBeirut returns a YYYY-MM-DD string', () => {
    const d = todayInBeirut(new Date('2026-07-09T12:00:00.000Z'));
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('todayInBeirutDateRange', () => {
  it('covers a plain 24-hour day', () => {
    const { startUtc, endUtc } = todayInBeirutDateRange('2026-08-23');
    expect(local(startUtc)).toBe('2026-08-23 00:00');
    expect(local(endUtc)).toBe('2026-08-24 00:00');
    expect(spanHours('2026-08-23')).toBe(24);
  });

  // Beirut ends DST at 2026-10-24T21:00Z: the clock falls 00:00 -> 23:00, so
  // 23:00-23:59 happens twice and 2026-10-24 is 25 hours long. Deriving the
  // day's end as start+24h landed back inside 2026-10-24, so the range
  // collapsed to zero width and every punch query returned nothing - the
  // "Today" tile would have read 0m all day for all sixteen staff.
  describe('the fall-back day (2026-10-24, 25 hours)', () => {
    it('is a full 25-hour day, not an empty range', () => {
      expect(spanHours('2026-10-24')).toBe(25);
    });

    it('starts at local midnight and ends at the next local midnight', () => {
      const { startUtc, endUtc } = todayInBeirutDateRange('2026-10-24');
      expect(local(startUtc)).toBe('2026-10-24 00:00');
      expect(local(endUtc)).toBe('2026-10-25 00:00');
      expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());
    });

    it('covers both passes of the repeated 23:00 hour', () => {
      expect(covers('2026-10-24', '23:00')).toBe(true);
      expect(covers('2026-10-24', '23:59')).toBe(true);
    });

    it('hands over cleanly to the next day', () => {
      expect(todayInBeirutDateRange('2026-10-24').endUtc.getTime()).toBe(
        todayInBeirutDateRange('2026-10-25').startUtc.getTime(),
      );
      expect(spanHours('2026-10-25')).toBe(24);
    });
  });

  // Beirut starts DST at 2026-03-28T22:00Z: the clock jumps 00:00 -> 01:00, so
  // midnight on 2026-03-29 never happens and that day is 23 hours long. The
  // day *before* it is a normal 24 hours, but the old code stopped it an hour
  // early and dropped local 23:00-23:59.
  describe('the spring-forward boundary (2026-03-28 / 2026-03-29)', () => {
    it('leaves the day before the transition a full 24 hours', () => {
      expect(spanHours('2026-03-28')).toBe(24);
      expect(covers('2026-03-28', '23:00')).toBe(true);
      expect(covers('2026-03-28', '23:59')).toBe(true);
    });

    it('starts the short day at the transition, since its midnight never happens', () => {
      const { startUtc, endUtc } = todayInBeirutDateRange('2026-03-29');
      expect(local(startUtc)).toBe('2026-03-29 01:00');
      expect(local(endUtc)).toBe('2026-03-30 00:00');
      expect(spanHours('2026-03-29')).toBe(23);
    });

    it('hands over cleanly across the transition', () => {
      expect(todayInBeirutDateRange('2026-03-28').endUtc.getTime()).toBe(
        todayInBeirutDateRange('2026-03-29').startUtc.getTime(),
      );
    });
  });

  it('rolls over a month and a year boundary', () => {
    expect(local(todayInBeirutDateRange('2026-01-31').endUtc)).toBe('2026-02-01 00:00');
    expect(local(todayInBeirutDateRange('2026-12-31').endUtc)).toBe('2027-01-01 00:00');
    expect(spanHours('2026-01-31')).toBe(24);
    expect(spanHours('2026-12-31')).toBe(24);
  });
});

describe('previousBeirutDate', () => {
  it('steps back one calendar day, including over month and year boundaries', () => {
    expect(previousBeirutDate('2026-08-23')).toBe('2026-08-22');
    expect(previousBeirutDate('2026-03-01')).toBe('2026-02-28');
    expect(previousBeirutDate('2027-01-01')).toBe('2026-12-31');
  });

  it('does not skip the short DST day the morning after it', () => {
    // 2026-03-29 is 23 hours long. watchedDetector runs at 00:10 and judges
    // "the day that just ended"; deriving that from now-24h landed on
    // 2026-03-28 and 2026-03-29 was never checked for absences at all.
    expect(previousBeirutDate('2026-03-30')).toBe('2026-03-29');
    expect(previousBeirutDate('2026-10-25')).toBe('2026-10-24');
  });
});
