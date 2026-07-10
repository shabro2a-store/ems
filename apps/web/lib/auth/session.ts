import { zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN,
  SHOP_TZ,
} from './constants';

export type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN';

export interface ScheduleEntry {
  weekday: number;
  start_time: string;
  end_time: string;
}

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

export interface ResolvedSchedule {
  schedule: ScheduleEntry;
  scheduleDate: string;
  startUtc: Date;
  endUtc: Date;
}

export function findScheduleInPast24h(
  schedules: ScheduleEntry[],
  now: Date,
): ResolvedSchedule | null {
  const nowMs = now.getTime();
  const windowMs = 24 * 60 * 60_000;
  let best: ResolvedSchedule | null = null;
  let bestStartMs = -Infinity;
  const todayWd = beirutWeekday(now);

  for (const s of schedules) {
    let candidateDate = todayInBeirut(now);
    if (s.weekday !== todayWd) {
      const daysBack = (todayWd - s.weekday + 7) % 7;
      const candidateMs = nowMs - daysBack * 24 * 60 * 60_000;
      candidateDate = formatInTimeZone(new Date(candidateMs), SHOP_TZ, 'yyyy-MM-dd');
    }
    const startUtc = scheduledToUtc(candidateDate, s.start_time);
    const startMs = startUtc.getTime();
    if (startMs < nowMs - windowMs || startMs > nowMs) continue;
    let endUtc = scheduledToUtc(candidateDate, s.end_time);
    if (endUtc.getTime() <= startUtc.getTime()) {
      endUtc = new Date(endUtc.getTime() + 24 * 60 * 60_000);
    }
    if (startMs > bestStartMs) {
      best = { schedule: s, scheduleDate: candidateDate, startUtc, endUtc };
      bestStartMs = startMs;
    }
  }
  return best;
}

export function sessionExpiryFor(
  user: SessionUser,
  schedules: ScheduleEntry[],
  now: Date,
): Date {
  if (user.role === 'DRIVER') {
    const recent = findScheduleInPast24h(schedules, now);
    if (recent) {
      return addMinutes(maxDate(recent.endUtc, now), SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN);
    }
    return addMinutes(now, SESSION_TTL_EMPLOYEE_MIN);
  }
  return addMinutes(now, SESSION_TTL_EMPLOYEE_MIN);
}