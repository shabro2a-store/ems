import { formatInTimeZone } from 'date-fns-tz';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_CHECKED_IN_MIN,
  SHOP_TZ,
} from './constants';

export type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER';

export interface SessionUser {
  role: Role;
}

export function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

export function todayInBeirut(now: Date = new Date()): string {
  return formatInTimeZone(now, SHOP_TZ, 'yyyy-MM-dd');
}

export function sessionExpiryFor(
  user: SessionUser,
  hasOpenPunch: boolean,
  now: Date,
): Date {
  if (user.role === 'DRIVER' && hasOpenPunch) {
    return addMinutes(now, SESSION_TTL_DRIVER_CHECKED_IN_MIN);
  }
  return addMinutes(now, SESSION_TTL_EMPLOYEE_MIN);
}
