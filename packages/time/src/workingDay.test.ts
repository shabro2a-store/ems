import { describe, it, expect } from 'vitest';
import { assignWorkingDays, SHIFT_GAP_MIN, shiftDateOf } from './index';

/*
 * Every case here is a real one, taken from the shop's own punches. Beirut is
 * UTC+3 throughout these dates, and times are written as the owner reads them.
 */
type P = { kind: 'IN' | 'OUT'; at: Date };
const b = (kind: 'IN' | 'OUT', wallClock: string): P => ({ kind, at: new Date(wallClock + '+03:00') });
const days = (punches: P[]) => assignWorkingDays(punches);

describe('the threshold itself', () => {
  it('is 4h15m, between the longest break and the shortest rest', () => {
    expect(SHIFT_GAP_MIN).toBe(255);
    expect(SHIFT_GAP_MIN).toBeGreaterThan(178); // Sally.k's 2h58m break
    expect(SHIFT_GAP_MIN).toBeLessThan(332); // aaref's 5h32m sleep
  });
});

describe('dani - the night worker the clock boundary was invented for', () => {
  it('gives four consecutive nights four consecutive days', () => {
    // His start drifts either side of midnight, so two of these nights begin on
    // the same calendar date. At a midnight boundary they stacked into one
    // 968-minute day and raised eight hours of overtime nobody worked.
    const punches: P[] = [
      b('IN', '2026-09-01T00:02'), b('OUT', '2026-09-01T08:00'),
      b('IN', '2026-09-02T00:02'), b('OUT', '2026-09-02T08:00'),
      b('IN', '2026-09-02T23:58'), b('OUT', '2026-09-03T08:08'),
      b('IN', '2026-09-04T00:05'), b('OUT', '2026-09-04T08:00'),
    ];
    expect(days(punches)).toEqual([
      '2026-09-01', '2026-09-01',
      '2026-09-02', '2026-09-02',
      '2026-09-03', '2026-09-03', // started 23:58 on the 2nd; the 2nd was taken
      '2026-09-04', '2026-09-04',
    ]);
  });
});

describe('Bilal - the day worker a 04:00 boundary broke', () => {
  it('keeps his 00:24 start in September, where he worked it', () => {
    // 31 Aug 07:05-16:09, then 8h15m at home, then 1 Sep 00:24-16:34. The
    // boundary filed the second under 31 August: 25h14m on one day, 8h14m of
    // invented overtime, and sixteen hours moved into a month that then closed.
    const punches: P[] = [
      b('IN', '2026-08-31T07:05'), b('OUT', '2026-08-31T16:09'),
      b('IN', '2026-09-01T00:24'), b('OUT', '2026-09-01T16:34'),
    ];
    expect(days(punches)).toEqual(['2026-08-31', '2026-08-31', '2026-09-01', '2026-09-01']);
  });

  it('never merges his days, though he is only home 6h54m', () => {
    // The tightest genuine rest in the shop, and the ceiling on the threshold.
    const punches: P[] = [
      b('IN', '2026-09-02T07:05'), b('OUT', '2026-09-02T23:59'),
      b('IN', '2026-09-03T06:54'), b('OUT', '2026-09-03T23:59'),
      b('IN', '2026-09-04T06:53'), b('OUT', '2026-09-04T23:59'),
    ];
    expect(days(punches)).toEqual([
      '2026-09-02', '2026-09-02', '2026-09-03', '2026-09-03', '2026-09-04', '2026-09-04',
    ]);
  });
});

describe('the two cases no clock boundary could reach', () => {
  it('splits aaref, whose shifts BOTH start in the evening', () => {
    // 16:02-18:21 then 23:53. Both after 04:00, so every value of the old
    // setting left them stacked on one Friday. 5h32m apart is sleep.
    const punches: P[] = [
      b('IN', '2026-09-04T16:02'), b('OUT', '2026-09-04T18:21'),
      b('IN', '2026-09-04T23:53'), b('OUT', '2026-09-05T08:00'),
    ];
    expect(days(punches)).toEqual(['2026-09-04', '2026-09-04', '2026-09-05', '2026-09-05']);
  });

  it('splits Moustafa, out at 20:05 and back at 02:03', () => {
    const punches: P[] = [
      b('IN', '2026-09-01T08:00'), b('OUT', '2026-09-01T20:05'),
      b('IN', '2026-09-02T02:03'), b('OUT', '2026-09-02T11:00'),
    ];
    expect(days(punches)).toEqual(['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02']);
  });
});

describe('a break is not a new day', () => {
  it('keeps Sally.k together across the longest break on record', () => {
    // 2h58m. Turning this into two days would judge each half short of a 9h
    // shift and dock both.
    const punches: P[] = [
      b('IN', '2026-08-17T02:50'), b('OUT', '2026-08-17T05:48'),
      b('IN', '2026-08-17T08:46'), b('OUT', '2026-08-17T14:00'),
    ];
    expect(days(punches)).toEqual(['2026-08-17', '2026-08-17', '2026-08-17', '2026-08-17']);
  });

  it('keeps a split evening together across midnight', () => {
    // Anas.s, out 21:14 and back 22:50 - 1h36m - finishing after midnight.
    const punches: P[] = [
      b('IN', '2026-08-30T14:00'), b('OUT', '2026-08-30T21:14'),
      b('IN', '2026-08-30T22:50'), b('OUT', '2026-08-31T02:00'),
    ];
    expect(days(punches)).toEqual(['2026-08-30', '2026-08-30', '2026-08-30', '2026-08-30']);
  });

  it('holds to the minute on either side of the line', () => {
    const noon = new Date('2026-09-10T12:00+03:00');
    const backAfter = (min: number): P[] => [
      b('IN', '2026-09-10T08:00'),
      b('OUT', '2026-09-10T12:00'),
      { kind: 'IN', at: new Date(noon.getTime() + min * 60_000) },
    ];
    expect(days(backAfter(SHIFT_GAP_MIN - 1))[2]).toBe('2026-09-10'); // 4h14m: same day
    expect(days(backAfter(SHIFT_GAP_MIN))[2]).toBe('2026-09-11'); // 4h15m: new day
  });
});

describe('the history this has to survive', () => {
  it('treats adam.m four taps in eight minutes as one working day', () => {
    // 23:53, 23:53, 23:56, 00:01 - the old check-in race. One lands on the next
    // calendar date, and none of them may open a second working day.
    const punches: P[] = [
      b('IN', '2026-08-27T23:53'), b('IN', '2026-08-27T23:53'),
      b('IN', '2026-08-27T23:56'), b('IN', '2026-08-28T00:01'),
      b('OUT', '2026-08-28T08:00'),
    ];
    expect(days(punches)).toEqual([
      '2026-08-27', '2026-08-27', '2026-08-27', '2026-08-27', '2026-08-27',
    ]);
  });

  it('ignores a checkout with no arrival before it', () => {
    const punches: P[] = [b('OUT', '2026-09-01T08:00'), b('IN', '2026-09-01T18:00')];
    expect(days(punches)).toEqual([null, '2026-09-01']);
  });

  it('does not care what order it is handed the punches in', () => {
    const chronological: P[] = [
      b('IN', '2026-09-01T07:00'), b('OUT', '2026-09-01T16:00'),
      b('IN', '2026-09-02T00:30'), b('OUT', '2026-09-02T09:00'),
    ];
    const shuffled = [chronological[2]!, chronological[0]!, chronological[3]!, chronological[1]!];
    expect(days(shuffled)).toEqual(['2026-09-02', '2026-09-01', '2026-09-02', '2026-09-01']);
  });

  it('gives an ordinary daytime week the ordinary answer', () => {
    // The overwhelming majority of the shop. Nothing clever may happen here.
    const punches: P[] = [];
    for (const d of ['07', '08', '09', '10', '11']) {
      punches.push(b('IN', '2026-09-' + d + 'T08:00'), b('OUT', '2026-09-' + d + 'T17:00'));
    }
    expect(days(punches)).toEqual([
      '2026-09-07', '2026-09-07', '2026-09-08', '2026-09-08', '2026-09-09', '2026-09-09',
      '2026-09-10', '2026-09-10', '2026-09-11', '2026-09-11',
    ]);
  });

  it('leaves a gap in the roster alone - a day off is not a collision', () => {
    // Two nights with a night off between them. The second must NOT be pulled
    // back onto the free date by the collision rule; it only ever moves forward.
    const punches: P[] = [
      b('IN', '2026-09-01T23:00'), b('OUT', '2026-09-02T07:00'),
      b('IN', '2026-09-04T23:00'), b('OUT', '2026-09-05T07:00'),
    ];
    expect(days(punches)).toEqual(['2026-09-01', '2026-09-01', '2026-09-04', '2026-09-04']);
  });
});

/*
 * The changeover. Attribution is recomputed from the punches every time anyone
 * opens payroll, so switching rules outright would silently move every shift
 * ever worked - across month boundaries that have already been paid. One
 * employee needed a manual top-up when a single shift moved. So the rest rule
 * applies from an instant forward, and everything before it keeps the answer it
 * has always had.
 */
describe('the cutover leaves history exactly as it was', () => {
  const CUTOVER = new Date('2026-09-08T00:00:00+03:00');
  // The old rule as Bilal actually had it: his branch's 04:00 boundary.
  const oldRule = { restRuleFrom: CUTOVER, legacyDayOf: (at: Date) => shiftDateOf(at, 4) };

  const BILAL_AUGUST: P[] = [
    b('IN', '2026-08-31T07:05'), b('OUT', '2026-08-31T16:09'),
    b('IN', '2026-09-01T00:24'), b('OUT', '2026-09-01T16:34'),
  ];

  it('still files his 00:24 under 31 August, wrong and paid', () => {
    // The bug, preserved on purpose. August was settled against this figure and
    // topped up by hand; recomputing it now would take the money back.
    expect(assignWorkingDays(BILAL_AUGUST, oldRule)).toEqual([
      '2026-08-31', '2026-08-31', '2026-08-31', '2026-08-31',
    ]);
  });

  it('and the same punches after the cutover come out right', () => {
    const september: P[] = [
      b('IN', '2026-09-30T07:05'), b('OUT', '2026-09-30T16:09'),
      b('IN', '2026-10-01T00:24'), b('OUT', '2026-10-01T16:34'),
    ];
    expect(assignWorkingDays(september, oldRule)).toEqual([
      '2026-09-30', '2026-09-30', '2026-10-01', '2026-10-01',
    ]);
  });

  it('leaves a shift in progress across the instant whole', () => {
    // Arrival decides, so somebody clocked in on the 7th and out on the 8th is
    // one shift on the 7th - not half under each rule.
    const straddling: P[] = [b('IN', '2026-09-07T20:00'), b('OUT', '2026-09-08T13:00')];
    expect(assignWorkingDays(straddling, oldRule)).toEqual(['2026-09-07', '2026-09-07']);
  });

  it('sees dates the old rule claimed, so the two cannot collide', () => {
    // A legacy shift takes the 8th; a rest-decided shift later that same day
    // must move forward rather than land on top of it.
    const late = { restRuleFrom: new Date('2026-09-08T12:00:00+03:00'), legacyDayOf: (at: Date) => shiftDateOf(at, 4) };
    const punches: P[] = [
      b('IN', '2026-09-08T09:00'), b('OUT', '2026-09-08T11:00'), // legacy: the 8th
      b('IN', '2026-09-08T20:00'), b('OUT', '2026-09-09T04:00'), // rest: the 8th is taken
    ];
    expect(assignWorkingDays(punches, late)).toEqual([
      '2026-09-08', '2026-09-08', '2026-09-09', '2026-09-09',
    ]);
  });

  it('carries a working day across the instant when nobody went home', () => {
    // Out at 22:00 on the 7th, back at 01:00 on the 8th - three hours, so the
    // same working day continues even though the rule changed in between.
    const punches: P[] = [
      b('IN', '2026-09-07T14:00'), b('OUT', '2026-09-07T22:00'),
      b('IN', '2026-09-08T01:00'), b('OUT', '2026-09-08T06:00'),
    ];
    expect(assignWorkingDays(punches, oldRule)).toEqual([
      '2026-09-07', '2026-09-07', '2026-09-07', '2026-09-07',
    ]);
  });

  it('decides everything by rest when no cutover is given', () => {
    // What the rule looks like once the changeover is history.
    expect(assignWorkingDays(BILAL_AUGUST)).toEqual([
      '2026-08-31', '2026-08-31', '2026-09-01', '2026-09-01',
    ]);
  });
});
