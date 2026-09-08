import { describe, it, expect } from 'vitest';
import { computePayoutFromRows } from './payout';
import { scheduledToUtc } from 'time';
import { currentPayMonth, isMonthOpen, MONTH_CLOSE_GRACE_MIN } from './periodLock';

/*
 * The seam between two months, decided by rest like every other day boundary.
 * Beirut is UTC+3 through all of these dates.
 */
const RATE = [{ rate_cent: 226, effective_from: new Date('2020-01-01T00:00:00Z') }];
const p = (kind: 'IN' | 'OUT', iso: string) => ({ kind, at: new Date(iso) });

function pay(month: string, punches: ReturnType<typeof p>[], dayStartHour: number) {
  return computePayoutFromRows({
    userId: 'u1',
    punches: punches as never,
    rateChanges: RATE as never,
    adjustments: [],
    approvedAdvances: [],
    month,
    dayStartHour,
  });
}

// Three shifts around the seam, all for one person on a 04:00 boundary.
const DAY_SHIFT_30TH = [p('IN', '2026-09-30T04:00:00Z'), p('OUT', '2026-09-30T13:00:00Z')]; // 07:00-16:00 Wed 30
const NIGHT_INTO_THE_1ST = [p('IN', '2026-09-30T21:30:00Z'), p('OUT', '2026-10-01T05:00:00Z')]; // 00:30-08:00 Thu 1
// Starts AFTER the night one ends at 08:00 - the same person cannot be on two
// shifts at once, and the pairing quite rightly ignores an IN that arrives
// while one is already open.
const DAY_SHIFT_1ST = [p('IN', '2026-10-01T07:00:00Z'), p('OUT', '2026-10-01T16:00:00Z')]; // 10:00-19:00 Thu 1
const ALL = [...DAY_SHIFT_30TH, ...NIGHT_INTO_THE_1ST, ...DAY_SHIFT_1ST];

describe('a shift that starts after midnight, once the rest rule is in force', () => {
  it('is paid in the month it was actually worked, not the one before', () => {
    // A CHANGE, and a deliberate one. The clock boundary pulled a 00:30 start
    // back onto 30 September; the rest rule files it on 1 October, because that
    // is the day he came to work. Nothing is lost or cut off - the shift is
    // paid in full, in October.
    //
    // The two are incompatible by construction: pulling a post-midnight arrival
    // onto the previous day IS the clock boundary, and it is the thing that
    // filed Bilal's sixteen hours in a month that then closed.
    expect(pay('2026-09', NIGHT_INTO_THE_1ST, 4).hours).toBe(0);
    expect(pay('2026-10', NIGHT_INTO_THE_1ST, 4).hours).toBe(7.5);
  });

  it('answers the same whatever the old boundary said', () => {
    // The setting is dead after the cutover. Both values give one answer, which
    // is the point of taking the hour out of the rule entirely.
    expect(pay('2026-10', NIGHT_INTO_THE_1ST, 0).hours).toBe(7.5);
    expect(pay('2026-10', NIGHT_INTO_THE_1ST, 4).hours).toBe(7.5);
  });

  it('joins a return inside the rest window to the day already open', () => {
    // 30 Sep 07:00-16:00, then 1 Oct 00:30-08:00, then 1 Oct 10:00-19:00. The
    // last one is 2h after the previous checkout - he did not go home - so it
    // continues 1 October rather than opening a third day.
    expect(pay('2026-09', ALL, 4).hours).toBe(9); // the 30th alone
    expect(pay('2026-10', ALL, 4).hours).toBe(7.5 + 9); // the night and the day after it
  });

  it('never pays the same shift twice, or drops it', () => {
    const sep = pay('2026-09', ALL, 4);
    const oct = pay('2026-10', ALL, 4);
    const whole = pay('2026-09', ALL, 4).hours + oct.hours;
    expect(whole).toBe(25.5); // 9 + 7.5 + 9, every minute once
    expect(sep.grossCent + oct.grossCent).toBe(
      Math.floor((540 * 226) / 60) + Math.floor((450 * 226) / 60) + Math.floor((540 * 226) / 60),
    );
  });
});

describe('the LOCK, which was still using calendar midnight', () => {
  it('keeps September open through the small hours of 1 October', () => {
    // 00:30 Beirut on 1 October: a boundary-4 employee is still finishing
    // September's last working day, and payroll agrees. The lock used to say
    // September was already settled - so a shortfall raised on that very shift
    // could not be waived, and an undecided shortfall is DOCKED.
    const smallHours = new Date('2026-09-30T21:30:00Z');
    expect(currentPayMonth(smallHours)).toBe('2026-09');
    expect(isMonthOpen('2026-09', smallHours)).toBe(true);
    expect(isMonthOpen('2026-09-30', smallHours)).toBe(true);
  });

  it('closes it once no working day of it can still be running', () => {
    // Past the sweep's threshold plus a rest, measured from the last minute of
    // September - so nobody is still finishing a shift it would pay for.
    const settled = scheduledToUtc('2026-10-02', '01:00');
    expect(currentPayMonth(settled)).toBe('2026-10');
    expect(isMonthOpen('2026-09', settled)).toBe(false);
  });

  it('is unchanged in the middle of a month', () => {
    const midMonth = new Date('2026-09-15T09:00:00Z');
    expect(currentPayMonth(midMonth)).toBe('2026-09');
    expect(isMonthOpen('2026-09', midMonth)).toBe(true);
    expect(isMonthOpen('2026-08', midMonth)).toBe(false);
    expect(isMonthOpen('2026-10', midMonth)).toBe(true);
  });
});

describe('the month stays open until its last working day can be over', () => {
  it('is still open in the small hours of the 1st', () => {
    // People are finishing shifts September will pay for. Closing here left the
    // one shift most likely to need a ruling as the one nobody could rule on.
    expect(isMonthOpen('2026-09', scheduledToUtc('2026-10-01', '01:00'))).toBe(true);
    expect(isMonthOpen('2026-09', scheduledToUtc('2026-10-01', '23:00'))).toBe(true);
  });

  it('closes once no working day of it can still be running', () => {
    // The grace is the sweep's threshold plus the rest that ends a day, so a
    // shift opened in the last minute of September is certainly finished.
    expect(isMonthOpen('2026-09', scheduledToUtc('2026-10-02', '01:00'))).toBe(false);
  });

  it('is derived from the two rules, not picked', () => {
    expect(MONTH_CLOSE_GRACE_MIN).toBe(20 * 60 + 255);
  });

  it('leaves the middle of a month exactly as it was', () => {
    const midMonth = scheduledToUtc('2026-09-15', '12:00');
    expect(currentPayMonth(midMonth)).toBe('2026-09');
    expect(isMonthOpen('2026-08', midMonth)).toBe(false);
    expect(isMonthOpen('2026-10', midMonth)).toBe(true);
  });
});

/*
 * Two shifts on the last day of the month.
 *
 * Nothing here is a special case: it is the ordinary rule landing on the ordinary
 * seam. A second shift separated by rest opens a new working day, which takes
 * the next free date - and on the 30th the next free date is in October. A
 * second shift inside the rest window continues the day already open, which is
 * September's, whatever the clock says about it.
 */
const b = (kind: 'IN' | 'OUT', wallClock: string) => ({ kind, at: new Date(wallClock + '+03:00') });

describe('a second shift on the last day of the month', () => {
  it('goes to October when they went home first', () => {
    // Out 16:00, back 21:00 - five hours, so a new working day. 30 September is
    // taken by the first shift, so this one is 1 October and October pays it.
    const punches = [
      b('IN', '2026-09-30T08:00'), b('OUT', '2026-09-30T16:00'),
      b('IN', '2026-09-30T21:00'), b('OUT', '2026-10-01T05:00'),
    ];
    expect(pay('2026-09', punches, 0).hours).toBe(8);
    expect(pay('2026-10', punches, 0).hours).toBe(8);
  });

  it('stays in September when they did not', () => {
    // Out 16:00, back 19:00 - three hours is a break, not rest. One working day,
    // still the 30th, and every minute of it is September's even though half of
    // it happens in October.
    const punches = [
      b('IN', '2026-09-30T08:00'), b('OUT', '2026-09-30T16:00'),
      b('IN', '2026-09-30T19:00'), b('OUT', '2026-10-01T03:00'),
    ];
    expect(pay('2026-09', punches, 0).hours).toBe(16);
    expect(pay('2026-10', punches, 0).hours).toBe(0);
  });

  it('answers the same when the second shift starts after midnight', () => {
    // The clock is not consulted at any point, so a 03:00 start on the 1st is
    // decided by the five hours before it exactly like a 21:00 start would be.
    const punches = [
      b('IN', '2026-09-30T14:00'), b('OUT', '2026-09-30T22:00'),
      b('IN', '2026-10-01T03:00'), b('OUT', '2026-10-01T11:00'),
    ];
    expect(pay('2026-09', punches, 0).hours).toBe(8);
    expect(pay('2026-10', punches, 0).hours).toBe(8);
  });

  it('and counts a 01:00 return in September, because it is the same day', () => {
    // Out 22:00, back 01:00 - three hours. He never went home, so this is still
    // 30 September's shift and September pays all sixteen hours of it.
    const punches = [
      b('IN', '2026-09-30T14:00'), b('OUT', '2026-09-30T22:00'),
      b('IN', '2026-10-01T01:00'), b('OUT', '2026-10-01T09:00'),
    ];
    expect(pay('2026-09', punches, 0).hours).toBe(16);
    expect(pay('2026-10', punches, 0).hours).toBe(0);
  });

  it('holds to the minute on the seam', () => {
    const secondShift = (gapMin: number) => {
      const out = new Date('2026-09-30T16:00+03:00');
      return [
        b('IN', '2026-09-30T08:00'), b('OUT', '2026-09-30T16:00'),
        { kind: 'IN' as const, at: new Date(out.getTime() + gapMin * 60_000) },
        { kind: 'OUT' as const, at: new Date(out.getTime() + (gapMin + 480) * 60_000) },
      ];
    };
    expect(pay('2026-10', secondShift(254), 0).hours).toBe(0); // 4h14m: September
    expect(pay('2026-10', secondShift(255), 0).hours).toBe(8); // 4h15m: October
  });
});
