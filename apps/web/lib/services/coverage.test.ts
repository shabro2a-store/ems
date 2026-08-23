import { describe, it, expect } from 'vitest';
import {
  computeCoverage,
  currentShiftDayMinutes,
  MAX_OPEN_SESSION_MIN,
  type PunchLite,
} from './coverage';

const utc = (iso: string) => new Date(iso);
// 2026-08-17 is a Monday in Beirut (UTC+3 in August).
const MON = 1;
const RATE_CENT = 200; // $2.00/h
const flatRate = () => RATE_CENT;

function punches(...pairs: Array<[string, 'IN' | 'OUT']>): PunchLite[] {
  return pairs.map(([iso, kind]) => ({ kind, at: utc(iso) }));
}

describe('computeCoverage', () => {
  it('attributes an overnight shift wholly to the check-in day', () => {
    // 21:00 Mon Beirut = 18:00Z Mon; 07:00 Tue Beirut = 04:00Z Tue.
    const out = computeCoverage({
      punches: punches(['2026-08-17T18:00:00Z', 'IN'], ['2026-08-18T04:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-08-17');
    expect(out[0]!.workedMin).toBe(600);
    expect(out[0]!.requiredMin).toBe(480);
    expect(out[0]!.deltaMin).toBe(120);
    expect(out[0]!.closed).toBe(true);
  });

  it('sums multiple in/out pairs on the same day', () => {
    const out = computeCoverage({
      punches: punches(
        ['2026-08-17T05:00:00Z', 'IN'],
        ['2026-08-17T08:00:00Z', 'OUT'],
        ['2026-08-17T09:00:00Z', 'IN'],
        ['2026-08-17T12:00:00Z', 'OUT'],
      ),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map(),
    });
    expect(out[0]!.workedMin).toBe(360);
    expect(out[0]!.deltaMin).toBe(-120);
  });

  it('prices each interval at the rate in force when it closed', () => {
    // A RateChange is stamped effective_from the instant it is saved, so it can
    // land mid-workday. payout.ts prices every interval separately at its own
    // closing rate; this has to give the same answer or anything bounding a day
    // by its own pay is bounding it by the wrong number.
    const rates = [
      { rate_cent: 200, effective_from: utc('2020-01-01T00:00:00Z') },
      { rate_cent: 250, effective_from: utc('2026-08-17T11:00:00Z') }, // 14:00 Beirut
    ];
    const out = computeCoverage({
      punches: punches(
        ['2026-08-17T05:00:00Z', 'IN'], // 08:00-12:00 Beirut, 240 min at $2.00
        ['2026-08-17T09:00:00Z', 'OUT'],
        ['2026-08-17T12:00:00Z', 'IN'], // 15:00-16:00 Beirut, 60 min at $2.50
        ['2026-08-17T13:00:00Z', 'OUT'],
      ),
      rateCentAt: (at) => {
        let cent = 0;
        for (const r of rates) if (r.effective_from <= at) cent = r.rate_cent;
        return cent;
      },
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out[0]!.workedMin).toBe(300);
    // 800 + 250, not 300 minutes at one rate (which would be 1000 or 1250).
    expect(out[0]!.grossCent).toBe(1050);
  });

  it('leaves a day unclosed when a check-in has no checkout', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map(),
    });
    expect(out[0]!.closed).toBe(false);
    expect(out[0]!.workedMin).toBe(0);
  });

  it('lets an HOURS_CHANGE override beat the weekday value', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T09:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map([['2026-08-17', { kind: 'HOURS_CHANGE', shift_min: 240 }]]),
    });
    expect(out[0]!.requiredMin).toBe(240);
    expect(out[0]!.deltaMin).toBe(0);
  });

  it('treats a DAY_OFF override as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map([['2026-08-17', { kind: 'DAY_OFF', shift_min: null }]]),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('treats an unscheduled weekday as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map(),
      rateCentAt: flatRate,
      overridesByDate: new Map(),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('ignores a checkout with no preceding check-in', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      rateCentAt: flatRate,
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(0);
  });
});

describe('currentShiftDayMinutes', () => {
  it('keeps an overnight shift on its arrival day past midnight', () => {
    // 21:00 Mon Beirut = 18:00Z Mon. It is now 00:30 Tue Beirut = 21:30Z Mon.
    // Asking "which punches fall in today's calendar day" finds nothing here,
    // which is how a 21:00-07:00 employee used to vanish from the board at
    // midnight and read zero hours for the rest of the night.
    const out = currentShiftDayMinutes({
      punches: punches(['2026-08-17T18:00:00Z', 'IN']),
      now: utc('2026-08-17T21:30:00Z'),
    });
    expect(out.date).toBe('2026-08-17');
    expect(out.minutes).toBe(210);
    expect(out.openInAt).toEqual(utc('2026-08-17T18:00:00Z'));
  });

  it('adds a second session to the first instead of replacing it', () => {
    // In at 10:00 Beirut, out at 10:05, straight back in, now 11:55. Time since
    // the latest arrival is 110 minutes; the day is 115.
    const out = currentShiftDayMinutes({
      punches: punches(
        ['2026-08-17T07:00:00Z', 'IN'],
        ['2026-08-17T07:05:00Z', 'OUT'],
        ['2026-08-17T07:05:00Z', 'IN'],
      ),
      now: utc('2026-08-17T08:55:00Z'),
    });
    expect(out.minutes).toBe(115);
    expect(out.date).toBe('2026-08-17');
  });

  it('counts a finished day up to its last checkout, not to now', () => {
    const out = currentShiftDayMinutes({
      punches: punches(['2026-08-17T07:00:00Z', 'IN'], ['2026-08-17T11:00:00Z', 'OUT']),
      now: utc('2026-08-17T14:00:00Z'),
    });
    expect(out.minutes).toBe(240);
    expect(out.openInAt).toBeNull();
  });

  it('drops an open session too old to be a shift, and says so', () => {
    // missedCheckout only raises a flag; it never closes the punch. Someone who
    // forgot to punch out on Monday would otherwise read as present with 40-odd
    // hours on the board, and that number feeds the day's labour cost.
    const openedAt = utc('2026-08-17T07:00:00Z');
    const out = currentShiftDayMinutes({
      punches: [{ kind: 'IN', at: openedAt }],
      now: utc('2026-08-18T23:00:00Z'), // 40 hours later
    });
    expect(out.minutes).toBe(0);
    expect(out.openInAt).toBeNull();
    expect(out.staleOpenInAt).toEqual(openedAt);
    expect(out.date).toBe('2026-08-19'); // 02:00 Wed in Beirut - back to today
  });

  it('still counts a long but plausible shift, including a full 24-hour one', () => {
    // Schedule.shift_min allows 1440, so the boundary has to sit above a real
    // 24-hour shift or the clamp would truncate legitimate work.
    const openedAt = utc('2026-08-17T07:00:00Z');
    const at = (min: number) => new Date(openedAt.getTime() + min * 60_000);

    const dayLong = currentShiftDayMinutes({ punches: [{ kind: 'IN', at: openedAt }], now: at(24 * 60) });
    expect(dayLong.minutes).toBe(24 * 60);
    expect(dayLong.staleOpenInAt).toBeNull();

    const onTheLimit = currentShiftDayMinutes({
      punches: [{ kind: 'IN', at: openedAt }],
      now: at(MAX_OPEN_SESSION_MIN),
    });
    expect(onTheLimit.minutes).toBe(MAX_OPEN_SESSION_MIN);
    expect(onTheLimit.staleOpenInAt).toBeNull();

    const pastTheLimit = currentShiftDayMinutes({
      punches: [{ kind: 'IN', at: openedAt }],
      now: at(MAX_OPEN_SESSION_MIN + 1),
    });
    expect(pastTheLimit.minutes).toBe(0);
    expect(pastTheLimit.staleOpenInAt).toEqual(openedAt);
  });

  it('falls back to today when nothing is open', () => {
    const out = currentShiftDayMinutes({ punches: [], now: utc('2026-08-17T21:30:00Z') });
    expect(out.date).toBe('2026-08-18'); // 00:30 Tue in Beirut
    expect(out.minutes).toBe(0);
    expect(out.openInAt).toBeNull();
  });

  it('does not count yesterday\'s finished shift towards today', () => {
    // The overnight shift closed at 07:00 Tue but belongs to Mon, so Tuesday
    // starts from zero - the same attribution computeCoverage makes.
    const out = currentShiftDayMinutes({
      punches: punches(['2026-08-17T18:00:00Z', 'IN'], ['2026-08-18T04:00:00Z', 'OUT']),
      now: utc('2026-08-18T05:00:00Z'), // 08:00 Tue Beirut
    });
    expect(out.date).toBe('2026-08-18');
    expect(out.minutes).toBe(0);
  });
});
