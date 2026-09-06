import { shiftDateOf } from 'time';

/**
 * A pay month stops accepting changes the moment the next one begins.
 *
 * The owner's rule: the month you are in is live, everything before it is
 * settled. Payroll is paid monthly, so once October starts, September is money
 * that has already changed hands and a bonus added to it afterwards would
 * rewrite a figure somebody was paid against.
 *
 * "Now" is the Beirut month, not UTC. Every other date in this system is
 * decided in Beirut, and a two-hour disagreement here would leave the first
 * hours of the 1st writing into a month the payroll screen had already closed.
 *
 * And it ends where the working DAY ends, not at calendar midnight, which is
 * the same rule payroll already pays by: a pair belongs to the month of
 * shiftDateOf(arrival), so an employee on a 04:00 boundary who clocks in at
 * 00:30 on the 1st is starting the previous month's last shift. The lock used
 * midnight while payroll used the boundary, and for those few hours a shift was
 * being attributed to a month that was already refusing rulings on it. That
 * fails against the employee in both directions it can: an undecided shortfall
 * is DOCKED and an undecided blocked credit grants NOTHING, so the one shift
 * nobody could waive was the one most likely to need it.
 *
 * MONTH_CLOSE_HOUR rather than each person's own boundary, because the lock has
 * no user in hand at most call sites and erring long is free: holding the month
 * open a few extra hours risks a late ruling on a month about to be paid, while
 * closing early takes money off somebody with no button to give it back. It is
 * the ceiling on day_start_hour, so it can never be earlier than any employee's
 * working day ends - the API refuses a boundary above it for exactly that
 * reason.
 *
 * Note what this does NOT cover: an employee's own advance request, and a
 * punch correction. Those are how the record gets fixed, and a shortfall
 * discovered in a paid month still has to be correctable - what is frozen is
 * the money the owner rules on top of the record, not the record itself.
 */
export const MONTH_CLOSE_HOUR = 6;

export function currentPayMonth(now: Date = new Date()): string {
  return shiftDateOf(now, MONTH_CLOSE_HOUR).slice(0, 7);
}

/** 'YYYY-MM', or a 'YYYY-MM-DD' whose month is taken. */
export function isMonthOpen(month: string, now: Date = new Date()): boolean {
  return month.slice(0, 7) >= currentPayMonth(now);
}

export const CLOSED_MONTH_MESSAGE =
  'That month is closed. Payroll for it has already been settled, so bonuses, deductions and rulings can only be made on the current month.';
