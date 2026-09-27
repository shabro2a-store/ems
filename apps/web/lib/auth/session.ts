import { formatInTimeZone } from 'date-fns-tz';
import { ACCESS_TTL_MIN, SHOP_TZ } from './constants';

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

/**
 * When an access token issued now expires. The same for everyone: the client
 * renews it, so nobody needs a long one - including a driver on a long shift,
 * who used to be handed twelve hours at the punch because nothing renewed.
 */
export function accessExpiry(now: Date): Date {
  return addMinutes(now, ACCESS_TTL_MIN);
}
