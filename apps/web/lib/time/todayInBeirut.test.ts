import { describe, it, expect } from 'vitest';
import { todayInBeirut, inBeirut } from './todayInBeirut';

describe('todayInBeirut', () => {
  it('returns the same calendar date for a UTC time well within the Beirut day', () => {
    const noon = new Date('2026-07-10T09:00:00Z');
    expect(todayInBeirut(noon)).toBe('2026-07-10');
  });

  it('treats 23:30 UTC Sunday as Sunday in Beirut winter (UTC+2)', () => {
    const lateUtc = new Date('2026-01-04T23:30:00Z');
    expect(todayInBeirut(lateUtc)).toBe('2026-01-05');
  });

  it('treats early UTC Monday as Sunday in Beirut summer (UTC+3)', () => {
    const earlyUtc = new Date('2026-07-13T22:30:00Z');
    expect(todayInBeirut(earlyUtc)).toBe('2026-07-14');
  });

  it('inBeirut returns date + hhmm pair', () => {
    const noon = new Date('2026-07-10T09:00:00Z');
    const parts = inBeirut(noon);
    expect(parts.date).toBe('2026-07-10');
    expect(parts.hhmm).toMatch(/^\d{2}:\d{2}$/);
  });
});
