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