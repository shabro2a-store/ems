import { describe, it, expect } from 'vitest';
import { sessionExpiryFor, addMinutes, todayInBeirut } from './session';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN,
} from './constants';

const EMP_MIN = SESSION_TTL_EMPLOYEE_MIN;
const DRV_AFTER = SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN;

describe('session', () => {
  describe('employee path', () => {
    it('expiry is 2h after "last activity" (now)', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'EMPLOYEE' }, false, now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });

    it('still gets the standard TTL even with an open punch - shortened rule is DRIVER-only', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'EMPLOYEE' }, true, now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });
  });

  describe('driver path', () => {
    it('gets the standard TTL when there is no open punch', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'DRIVER' }, false, now);
      expect(exp.getTime()).toBe(addMinutes(now, EMP_MIN).getTime());
    });

    it('gets 30 minutes after now while checked in', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      const exp = sessionExpiryFor({ role: 'DRIVER' }, true, now);
      expect(exp.getTime()).toBe(addMinutes(now, DRV_AFTER).getTime());
    });
  });

  describe('todayInBeirut', () => {
    it('returns the Beirut calendar date', () => {
      const utcMidnightBeirutMorning = new Date('2026-07-09T00:30:00.000Z');
      expect(todayInBeirut(utcMidnightBeirutMorning)).toMatch(/^2026-07-0[89]/);
    });
  });
});
