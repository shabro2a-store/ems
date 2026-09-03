import { describe, it, expect } from 'vitest';
import { inBeirut, beirutWeekday, shiftDateOf, shiftWeekdayOf } from './index';

// Beirut is UTC+3 in summer, UTC+2 in winter.
const beirut = (iso: string) => new Date(iso);

describe('shiftDateOf with the default midnight boundary', () => {
  it('is the calendar date, identically, across a whole year', () => {
    // The property the default rests on: opting out must not merely usually
    // agree with the old behaviour, it must be the same string every time.
    let t = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365 * 24; i++) {
      const at = new Date(t);
      expect(shiftDateOf(at, 0)).toBe(inBeirut(at).date);
      expect(shiftWeekdayOf(at, 0)).toBe(beirutWeekday(at));
      t += 3_600_000;
    }
  });
});

describe('shiftDateOf with a 6am boundary', () => {
  // Dani: in at 23:00 some nights, 00:00 others, out at 07:00 either way.
  it('puts both of his start times on the same working day', () => {
    // Wed 2 Sep 23:00 Beirut = 20:00Z, and Thu 3 Sep 00:00 = 21:00Z Wed.
    expect(shiftDateOf(beirut('2026-09-02T20:00:00Z'), 6)).toBe('2026-09-02');
    expect(shiftDateOf(beirut('2026-09-02T21:00:00Z'), 6)).toBe('2026-09-02');
  });

  it('separates consecutive nights instead of stacking them', () => {
    // The failure: 00:02 Wed and 23:58 Wed both landed on Wednesday.
    const first = shiftDateOf(beirut('2026-09-01T21:02:00Z'), 6); // Wed 00:02
    const second = shiftDateOf(beirut('2026-09-02T20:58:00Z'), 6); // Wed 23:58
    expect(first).toBe('2026-09-01');
    expect(second).toBe('2026-09-02');
    expect(first).not.toBe(second);
  });

  it('leaves the 7am handover and every day shift where they were', () => {
    // Khouder clocks in at 07:00, an hour past the boundary.
    expect(shiftDateOf(beirut('2026-09-02T04:00:00Z'), 6)).toBe('2026-09-02'); // 07:00
    expect(shiftDateOf(beirut('2026-09-02T05:00:00Z'), 6)).toBe('2026-09-02'); // 08:00
    expect(shiftDateOf(beirut('2026-09-02T13:00:00Z'), 6)).toBe('2026-09-02'); // 16:00
  });

  it('leaves an evening start on its own day, as it already was', () => {
    // 21:00 -> 07:00 staff must not move: 21:00 is past the boundary.
    expect(shiftDateOf(beirut('2026-09-02T18:00:00Z'), 6)).toBe('2026-09-02');
  });

  it('carries the weekday with the day', () => {
    // 00:00 Thu belongs to Wednesday, so it owes WEDNESDAY's hours.
    const at = beirut('2026-09-02T21:00:00Z');
    expect(shiftDateOf(at, 6)).toBe('2026-09-02');
    expect(shiftWeekdayOf(at, 6)).toBe(3); // Wednesday
    expect(beirutWeekday(at)).toBe(4); // the calendar says Thursday
  });

  it('holds across both DST switches', () => {
    // Lebanon springs forward 2026-03-29 and falls back 2026-10-25; midnight
    // is missing on one and repeated on the other.
    expect(shiftDateOf(beirut('2026-03-29T00:30:00Z'), 6)).toBe('2026-03-28'); // 03:30 local
    expect(shiftDateOf(beirut('2026-10-24T22:30:00Z'), 6)).toBe('2026-10-24'); // 01:30 local
  });
});
