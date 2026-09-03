import { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } from 'date-fns-tz';

export const SHOP_TZ = 'Asia/Beirut';

export function inBeirut(d: Date): { date: string; hhmm: string } {
  const zoned = utcToZonedTime(d, SHOP_TZ);
  return {
    date: formatInTimeZone(d, SHOP_TZ, 'yyyy-MM-dd'),
    hhmm: formatInTimeZone(d, SHOP_TZ, 'HH:mm'),
  };
}

export function todayInBeirut(now: Date = new Date()): string {
  return inBeirut(now).date;
}

export function beirutWeekday(now: Date = new Date()): number {
  const iso = Number(formatInTimeZone(now, SHOP_TZ, 'i'));
  return iso === 7 ? 0 : iso;
}

export function scheduledToUtc(date: string, hhmm: string): Date {
  return zonedTimeToUtc(`${date} ${hhmm}`, SHOP_TZ);
}

/** The calendar date `offset` days from this one. Never arithmetic on an
 * instant: a Beirut day is 23 or 25 hours long twice a year, so "+/-24h" names
 * the wrong date on the days either side of a transition. */
function shiftCalendarDate(date: string, offset: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y as number, (m as number) - 1, (d as number) + offset);
  if (Number.isNaN(t)) return date; // malformed input - same garbage in, garbage out as before
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The Beirut calendar date before this one. Anything judging "the day that just
 * ended" must ask the calendar: subtracting 24 hours from an instant lands on
 * the wrong date the morning after a short DST day, which silently skips it.
 */
export function previousBeirutDate(date: string): string {
  return shiftCalendarDate(date, -1);
}

/**
 * The first instant belonging to the given Beirut calendar date.
 *
 * Usually local midnight. On the spring-forward day it is not: Beirut jumps
 * 00:00 -> 01:00, so midnight never happens and zonedTimeToUtc answers with an
 * instant that still belongs to the previous date. Stepping forward to the
 * first minute that really lands on the date finds the transition itself,
 * which is where the day begins. The loop only ever runs one day a year and
 * exits within the length of the gap.
 */
function beirutDayStart(date: string): Date {
  const midnight = zonedTimeToUtc(`${date} 00:00:00`, SHOP_TZ);
  if (Number.isNaN(midnight.getTime())) return midnight;
  if (formatInTimeZone(midnight, SHOP_TZ, 'yyyy-MM-dd') === date) return midnight;
  for (let minutes = 1; minutes <= 24 * 60; minutes++) {
    const t = new Date(midnight.getTime() + minutes * 60_000);
    if (formatInTimeZone(t, SHOP_TZ, 'yyyy-MM-dd') === date) return t;
  }
  return midnight;
}

/**
 * Returns the UTC [start, end) range for the given Beirut-local day: from the
 * first instant of that date to the first instant of the next.
 *
 * Both ends are resolved from the calendar date, never by adding 24 hours to
 * an instant. Doing the latter broke on both Beirut DST days: on the 25-hour
 * fall-back day (2026-10-24) start+24h landed back inside the same date and
 * the range collapsed to nothing, and on the day before the spring-forward
 * (2026-03-28) it lost the last local hour. Every caller windows punches with
 * this, so an empty range reads as "nobody worked".
 */
export function todayInBeirutDateRange(date: string): { startUtc: Date; endUtc: Date } {
  return { startUtc: beirutDayStart(date), endUtc: beirutDayStart(shiftCalendarDate(date, 1)) };
}
/**
 * The working day a moment belongs to, when the day does not begin at midnight.
 *
 * Some shifts sit ON the midnight line. Dani starts at 23:00 some nights and
 * 00:00 others and finishes at 07:00 either way: one shift, but the calendar
 * puts the two starts on different dates, so one night landed a second shift on
 * a day that already had one - 968 minutes against 8 owed, reported as eight
 * hours of overtime - and left the next day with nothing, looking like an
 * absence. Two minutes decided which.
 *
 * Moving the boundary to an hour when nobody is starting a shift fixes it
 * without touching the rule everything else is built on: a shift still belongs
 * to the day it clocked IN, that day just runs 06:00 to 06:00 rather than
 * 00:00 to 00:00. Both of dani's starts then name the same day, while the
 * handover at 07:00 and every day shift are on the ordinary side of it.
 *
 * `dayStartHour` 0 is the calendar day, and this is then EXACTLY inBeirut().date
 * - the same string, by construction, not merely usually. That is what lets the
 * setting default to 0 and change nothing anywhere until a branch opts in.
 */
export function shiftDateOf(at: Date, dayStartHour = 0): string {
  const { date, hhmm } = inBeirut(at);
  if (dayStartHour <= 0) return date;
  return Number(hhmm.slice(0, 2)) >= dayStartHour ? date : previousBeirutDate(date);
}

/**
 * The weekday of the working day a moment belongs to - which is what decides
 * the hours it owes, so it has to move with shiftDateOf or a night shift would
 * be measured against the wrong day's schedule.
 *
 * Resolved from the shift DATE rather than the instant: noon on that date is
 * inside it in Beirut on every day of the year, including both DST days, where
 * midnight is either ambiguous or does not exist.
 */
export function shiftWeekdayOf(at: Date, dayStartHour = 0): number {
  if (dayStartHour <= 0) return beirutWeekday(at);
  return beirutWeekday(new Date(`${shiftDateOf(at, dayStartHour)}T12:00:00.000Z`));
}
