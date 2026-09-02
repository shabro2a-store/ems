import { todayInBeirut } from 'time';

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
 * Note what this does NOT cover: an employee's own advance request, and a
 * punch correction. Those are how the record gets fixed, and a shortfall
 * discovered in a paid month still has to be correctable - what is frozen is
 * the money the owner rules on top of the record, not the record itself.
 */
export function currentPayMonth(now: Date = new Date()): string {
  return todayInBeirut(now).slice(0, 7);
}

/** 'YYYY-MM', or a 'YYYY-MM-DD' whose month is taken. */
export function isMonthOpen(month: string, now: Date = new Date()): boolean {
  return month.slice(0, 7) >= currentPayMonth(now);
}

export const CLOSED_MONTH_MESSAGE =
  'That month is closed. Payroll for it has already been settled, so bonuses, deductions and rulings can only be made on the current month.';
