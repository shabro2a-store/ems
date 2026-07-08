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

export function scheduledToUtc(date: string, hhmm: string): Date {
  return zonedTimeToUtc(`${date} ${hhmm}`, SHOP_TZ);
}