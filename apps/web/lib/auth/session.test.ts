import { describe, it, expect } from 'vitest';
import { accessExpiry, addMinutes, todayInBeirut } from './session';
import { ACCESS_TTL_MIN } from './constants';

describe('session', () => {
  describe('access token lifetime', () => {
    it('is the same short window for everyone - the client renews it', () => {
      const now = new Date('2026-07-09T12:00:00.000Z');
      expect(accessExpiry(now).getTime()).toBe(addMinutes(now, ACCESS_TTL_MIN).getTime());
      expect(ACCESS_TTL_MIN).toBeLessThanOrEqual(15);
    });
  });

  describe('todayInBeirut', () => {
    it('returns the Beirut calendar date', () => {
      const utcMidnightBeirutMorning = new Date('2026-07-09T00:30:00.000Z');
      expect(todayInBeirut(utcMidnightBeirutMorning)).toMatch(/^2026-07-0[89]/);
    });
  });
});
