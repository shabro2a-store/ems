import { describe, it, expect } from 'vitest';
import { computePayoutFromRows } from './payout';
import { scheduledToUtc } from 'time';
import { currentPayMonth, isMonthOpen, MONTH_CLOSE_HOUR } from './periodLock';

/*
 * The month has to end where the working DAY ends, not at calendar midnight.
 *
 * Beirut is UTC+3 in September. A 04:00 boundary means 30 September runs until
 * 04:00 on 1 October, so somebody who clocks in at 00:30 on the 1st is starting
 * September's last shift, and must be paid in September.
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

describe('payroll already ends the month on the working-day boundary', () => {
  it('pays a 00:30 start on the 1st in the month before', () => {
    // The shift that would be "cut off" by a midnight month. It is not: the
    // month a pair belongs to is decided by shiftDateOf on its ARRIVAL, which
    // already respects the boundary.
    expect(pay('2026-09', NIGHT_INTO_THE_1ST, 4).hours).toBe(7.5);
    expect(pay('2026-10', NIGHT_INTO_THE_1ST, 4).hours).toBe(0);
  });

  it('and would put it in the new month at a midnight boundary', () => {
    // The same punches with no boundary: now it IS October's, which is correct
    // for somebody whose day starts at midnight. Same rule, different day.
    expect(pay('2026-09', NIGHT_INTO_THE_1ST, 0).hours).toBe(0);
    expect(pay('2026-10', NIGHT_INTO_THE_1ST, 0).hours).toBe(7.5);
  });

  it('splits two shifts on one calendar day into the two months they belong to', () => {
    // 1 October holds both the 00:30 start (September's working day) and the
    // 07:00 start (October's). Each pair is judged on its own arrival, so one
    // calendar day feeding two months is not a special case.
    expect(pay('2026-09', ALL, 4).hours).toBe(9 + 7.5); // the 30th, plus the night
    expect(pay('2026-10', ALL, 4).hours).toBe(9); // only the 10:00 start
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

  it('closes it once that working day is genuinely over', () => {
    // 06:00 Beirut on 1 October - past every boundary an employee may have.
    const morning = new Date('2026-10-01T03:00:00Z');
    expect(currentPayMonth(morning)).toBe('2026-10');
    expect(isMonthOpen('2026-09', morning)).toBe(false);
  });

  it('is unchanged in the middle of a month', () => {
    const midMonth = new Date('2026-09-15T09:00:00Z');
    expect(currentPayMonth(midMonth)).toBe('2026-09');
    expect(isMonthOpen('2026-09', midMonth)).toBe(true);
    expect(isMonthOpen('2026-08', midMonth)).toBe(false);
    expect(isMonthOpen('2026-10', midMonth)).toBe(true);
  });
});

describe('the ceiling that keeps the two in step', () => {
  it('no working day may start after the month closes', () => {
    // The invariant the whole fix rests on. If an employee could be given a
    // boundary later than MONTH_CLOSE_HOUR, their last working day of the month
    // would still be running after the month had settled - and we would be back
    // to a shift nobody can rule on. The API refuses it; this states why.
    const HIGHEST_BOUNDARY_THE_API_ACCEPTS = 6;
    expect(HIGHEST_BOUNDARY_THE_API_ACCEPTS).toBeLessThanOrEqual(MONTH_CLOSE_HOUR);
  });

  it('holds September open to the last minute of every allowed boundary', () => {
    for (let boundary = 0; boundary <= MONTH_CLOSE_HOUR; boundary++) {
      // One minute before this person's 30 September rolls into October.
      const lastMinute =
        boundary === 0
          ? scheduledToUtc('2026-09-30', '23:59')
          : scheduledToUtc('2026-10-01', `${String(boundary - 1).padStart(2, '0')}:59`);
      expect(isMonthOpen('2026-09', lastMinute)).toBe(true);
    }
  });

  it('and closes it once the latest of them has passed', () => {
    expect(isMonthOpen('2026-09', scheduledToUtc('2026-10-01', '06:00'))).toBe(false);
  });
});
