import { describe, it, expect } from 'vitest';
import {
  sessionExpiryFor,
  findScheduleInPast24h,
  addMinutes,
  todayInBeirut,
  scheduledToUtc,
  beirutWeekday,
} from './session';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN,
} from './constants';

const EMP_MIN = SESSION_TTL_EMPLOYEE_MIN;
const DRV_AFTER = SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN;

describe('session', () => {
  describe('employee path', () => {
    it('expiry is 2h after "last activity" (now)', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'EMPLOYEE' }, [], now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });

    it('does not consult schedules for employees', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'EMPLOYEE' }, [{ weekday: 0, start_time: '00:00', end_time: '23:59' }], now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });
  });

  describe('driver with schedule', () => {
    it('expiry is end_time + 30 min, for a schedule earlier today', () => {
      const wd = beirutWeekday(new Date('2026-07-09T07:00:00.000Z'));
      const today = todayInBeirut(new Date('2026-07-09T07:00:00.000Z'));
      const now = new Date('2026-07-09T07:00:00.000Z');
      const exp = sessionExpiryFor(
        { role: 'DRIVER' },
        [{ weekday: wd, start_time: '09:00', end_time: '14:00' }],
        now,
      );
      const expectedEnd = scheduledToUtc(today, '14:00');
      const expected = addMinutes(expectedEnd, DRV_AFTER);
      expect(exp.getTime()).toBe(expected.getTime());
    });

    it('expiry clamps to now + 30 min if schedule end is in the past', () => {
      const wd = beirutWeekday(new Date('2026-07-09T15:00:00.000Z'));
      const now = new Date('2026-07-09T15:00:00.000Z');
      const exp = sessionExpiryFor(
        { role: 'DRIVER' },
        [{ weekday: wd, start_time: '08:00', end_time: '10:00' }],
        now,
      );
      const expected = addMinutes(now, DRV_AFTER);
      expect(exp.getTime()).toBe(expected.getTime());
    });
  });

  describe('driver without recent schedule', () => {
    it('falls back to 2h-idle rule (decision #34)', () => {
      const wd = (beirutWeekday(new Date('2026-07-09T12:00:00.000Z')) + 1) % 7;
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor(
        { role: 'DRIVER' },
        [{ weekday: wd, start_time: '09:00', end_time: '14:00' }],
        now,
      );
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });

    it('falls back when no schedules at all', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'DRIVER' }, [], now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });
  });

  describe('driver cross-midnight (decision #36)', () => {
    it('uses schedule that started in the past 24h', () => {
      const now = new Date('2026-07-09T02:00:00.000Z');
      const todayWd = beirutWeekday(now);
      const yesterdayWd = (todayWd + 6) % 7;
      const res = findScheduleInPast24h(
        [{ weekday: yesterdayWd, start_time: '22:00', end_time: '06:00' }],
        now,
      );
      expect(res).not.toBeNull();
      expect(res!.schedule.weekday).toBe(yesterdayWd);
      expect(res!.startUtc.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(res!.startUtc.getTime()).toBeGreaterThan(now.getTime() - 24 * 60 * 60_000);
      expect(res!.endUtc.getTime()).toBeGreaterThan(res!.startUtc.getTime());
    });

    it('session expiry for cross-midnight uses shifted endUtc', () => {
      const now = new Date('2026-07-09T02:00:00.000Z');
      const todayWd = beirutWeekday(now);
      const yesterdayWd = (todayWd + 6) % 7;
      const exp = sessionExpiryFor(
        { role: 'DRIVER' },
        [{ weekday: yesterdayWd, start_time: '22:00', end_time: '06:00' }],
        now,
      );
      const res = findScheduleInPast24h(
        [{ weekday: yesterdayWd, start_time: '22:00', end_time: '06:00' }],
        now,
      );
      const expected = addMinutes(res!.endUtc, DRV_AFTER);
      expect(exp.getTime()).toBe(expected.getTime());
    });
  });

  describe('findScheduleInPast24h', () => {
    it('returns null when no schedule starts in the past 24h', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const wd = (beirutWeekday(now) + 2) % 7;
      const res = findScheduleInPast24h(
        [{ weekday: wd, start_time: '09:00', end_time: '17:00' }],
        now,
      );
      expect(res).toBeNull();
    });

    it('returns the most recent of multiple matching schedules', () => {
      const wd = beirutWeekday(new Date('2026-07-09T12:00:00.000Z'));
      const res = findScheduleInPast24h(
        [
          { weekday: wd, start_time: '06:00', end_time: '10:00' },
          { weekday: wd, start_time: '09:00', end_time: '14:00' },
        ],
        new Date('2026-07-09T12:00:00.000Z'),
      );
      expect(res).not.toBeNull();
      expect(res!.schedule.start_time).toBe('09:00');
    });
  });

  describe('todayInBeirut', () => {
    it('returns the Beirut calendar date', () => {
      const utcMidnightBeirutMorning = new Date('2026-07-09T00:30:00.000Z');
      expect(todayInBeirut(utcMidnightBeirutMorning)).toMatch(/^2026-07-0[89]/);
    });
  });
});