import { zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN,
  SHOP_TZ,
} from './constants';

export type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER';

export interface SessionUser {
  role: Role;
}

export function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function todayInBeirut(now: Date = new Date()): string {
  return formatInTimeZone(now, SHOP_TZ, 'yyyy-MM-dd');
}

export function scheduledToUtc(date: string, hhmm: string): Date {
  return zonedTimeToUtc(`${date} ${hhmm}`, SHOP_TZ);
}

export function beirutWeekday(now: Date): number {
  const iso = Number(formatInTimeZone(now, SHOP_TZ, 'i'));
  return iso === 7 ? 0 : iso;
}

export function sessionExpiryFor(
  user: SessionUser,
  hasOpenPunch: boolean,
  now: Date,
): Date {
  if (user.role === 'DRIVER' && hasOpenPunch) {
    return addMinutes(now, SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN);
  }
  return addMinutes(now, SESSION_TTL_EMPLOYEE_MIN);
}
