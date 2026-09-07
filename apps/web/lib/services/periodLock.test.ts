import { describe, it, expect } from 'vitest';
import { isMonthOpen, currentPayMonth } from './periodLock';

// Beirut is UTC+3 in summer, UTC+2 in winter. "Now" here is always a real
// instant, and the month is always the Beirut one.
const AUG_31_LATE = new Date('2026-08-31T20:00:00Z'); // 31 Aug 23:00 Beirut
const SEP_01_EARLY = new Date('2026-08-31T21:30:00Z'); // 1 Sep 00:30 Beirut
const SEP_02_SETTLED = new Date('2026-09-01T22:00:00Z'); // 2 Sep 01:00 Beirut
const MID_SEP = new Date('2026-09-15T09:00:00Z');

describe('isMonthOpen', () => {
  it('keeps the month you are in open', () => {
    expect(isMonthOpen('2026-09', MID_SEP)).toBe(true);
  });

  it('closes every month before it', () => {
    expect(isMonthOpen('2026-08', MID_SEP)).toBe(false);
    expect(isMonthOpen('2025-12', MID_SEP)).toBe(false);
  });

  it('does not close a month that has not ended in Beirut yet', () => {
    // 23:00 on the 31st is still August here, and UTC already says September.
    // Deciding this in UTC would freeze the last hours of every month while the
    // payroll screen still showed them as live.
    expect(currentPayMonth(AUG_31_LATE)).toBe('2026-08');
    expect(isMonthOpen('2026-08', AUG_31_LATE)).toBe(true);
  });

  it('holds August open through the small hours of 1 September', () => {
    // The month ends where the working DAY ends, which is the rule payroll
    // already pays by: an employee on a 04:00 boundary who clocks in at 00:30
    // on the 1st is starting AUGUST's last shift, and is paid in August.
    // Closing the lock at midnight meant that shift was attributed to a month
    // already refusing rulings on it - and both undecided outcomes go against
    // the employee: a shortfall is docked, a blocked credit grants nothing.
    expect(currentPayMonth(SEP_01_EARLY)).toBe('2026-08');
    expect(isMonthOpen('2026-08', SEP_01_EARLY)).toBe(true);
    expect(isMonthOpen('2026-09', SEP_01_EARLY)).toBe(true);
  });

  it('closes it once no working day of it can still be running', () => {
    // The grace is the sweep's threshold plus the rest that ends a working day,
    // so a shift opened in August's last minute is certainly finished by here.
    expect(currentPayMonth(SEP_02_SETTLED)).toBe('2026-09');
    expect(isMonthOpen('2026-08', SEP_02_SETTLED)).toBe(false);
    expect(isMonthOpen('2026-09', SEP_02_SETTLED)).toBe(true);
  });

  it('accepts a full date and reads its month', () => {
    // The ruling routes are keyed by day, not month.
    expect(isMonthOpen('2026-09-30', MID_SEP)).toBe(true);
    expect(isMonthOpen('2026-08-31', MID_SEP)).toBe(false);
  });

  it('leaves a future month open', () => {
    // Not reachable from the UI, and refusing it would be the wrong answer if
    // it ever were: nothing has been paid for a month that has not happened.
    expect(isMonthOpen('2026-10', MID_SEP)).toBe(true);
  });
});
