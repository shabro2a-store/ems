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

/**
 * Returns the UTC [start, end) range for the given Beirut-local day.
 * start = midnight in Beirut, end = midnight of the next day in Beirut.
 */
export function todayInBeirutDateRange(date: string): { startUtc: Date; endUtc: Date } {
  const startLocal = `${date} 00:00:00`;
  const startUtc = zonedTimeToUtc(startLocal, SHOP_TZ);
  // end = start of next day. Add 24h UTC roughly; then normalize by converting
  // a Beirut-local next-day-midnight.
  const nextDate = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  // Format nextDate as YYYY-MM-DD in Beirut tz, build next-day midnight
  const nextDateStr = formatInTimeZone(nextDate, SHOP_TZ, 'yyyy-MM-dd');
  const endUtc = zonedTimeToUtc(`${nextDateStr} 00:00:00`, SHOP_TZ);
  return { startUtc, endUtc };
}