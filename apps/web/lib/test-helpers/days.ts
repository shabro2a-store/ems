import { todayInBeirut, previousBeirutDate, scheduledToUtc } from 'time';

/**
 * A day an integration test can rule on whenever the suite runs: over, and in a
 * pay month that is still open.
 *
 * Yesterday in Beirut is always both. On the 1st it is the previous month's
 * last day, which stays open through the close grace; on any later day it is
 * this month. A fixed date is neither for long - the tests written in July
 * started failing with MONTH_CLOSED the day August's grace ran out.
 *
 * A shift on it must end by about 19:45 Beirut, so that it is past the rest
 * window by midnight and never still the day in progress.
 */
export function openPastDay(now: Date = new Date()): string {
  return previousBeirutDate(todayInBeirut(now));
}

/** An instant on `day`, given as Beirut wall-clock time, in either season. */
export function beirutAt(day: string, hhmm: string): Date {
  return scheduledToUtc(day, hhmm);
}
