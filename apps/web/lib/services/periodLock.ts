import { inBeirut, SHIFT_GAP_MIN } from 'time';
import { AUTO_CLOSE_AFTER_MIN } from './autoClose';

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
 * And it ends where the last working day OF that month ends, not at calendar
 * midnight. A shift belongs to the month of the working day it opened, and that
 * day is not over until the person has gone home - so at 01:00 on the 1st there
 * are still people finishing shifts that September will pay for. Closing the
 * lock at midnight put those shifts in a month already refusing rulings on
 * them, and both undecided outcomes go against the employee: a shortfall is
 * DOCKED and a blocked credit grants NOTHING. The one shift nobody could waive
 * was the one most likely to need it.
 *
 * The grace is derived, not chosen. No working day can outlive the sweep that
 * closes an abandoned session (AUTO_CLOSE_AFTER_MIN) plus the rest that ends a
 * working day (SHIFT_GAP_MIN) - so a day opened in the last minute of a month
 * is certainly over that long after the month was. September therefore closes
 * just after midnight on 2 October rather than on the 1st.
 *
 * A fixed hour cannot do this any more. There is no configured end-of-day left
 * to follow: the working day is defined by rest, so its end is a different
 * instant for every person and only knowable from their punches. Erring long is
 * free - holding a month open risks a late ruling on a month about to be paid,
 * while closing early takes money from somebody with no button to give it back.
 *
 * The residual case: a real shift longer than the sweep's threshold, kept alive
 * by a revoked auto-close, straddling month end. That is a double cover across
 * the 1st, it is vanishingly rare, and the owner is notified about it when it
 * happens.
 *
 * Note what this does NOT cover: an employee's own advance request, and a
 * punch correction. Those are how the record gets fixed, and a shortfall
 * discovered in a paid month still has to be correctable - what is frozen is
 * the money the owner rules on top of the record, not the record itself.
 */
export const MONTH_CLOSE_GRACE_MIN = AUTO_CLOSE_AFTER_MIN + SHIFT_GAP_MIN;

export function currentPayMonth(now: Date = new Date()): string {
  return inBeirut(new Date(now.getTime() - MONTH_CLOSE_GRACE_MIN * 60_000)).date.slice(0, 7);
}

/** 'YYYY-MM', or a 'YYYY-MM-DD' whose month is taken. */
export function isMonthOpen(month: string, now: Date = new Date()): boolean {
  return month.slice(0, 7) >= currentPayMonth(now);
}

export const CLOSED_MONTH_MESSAGE =
  'That month is closed. Payroll for it has already been settled, so bonuses, deductions and rulings can only be made on the current month.';
