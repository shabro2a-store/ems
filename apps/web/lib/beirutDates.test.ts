import { describe, it, expect } from 'vitest';
import { beirutToday, beirutMonth, formatMinutes, formatHours } from './api';

/*
 * #57: screens took "today" from the phone's clock - toISOString() is the UTC
 * date, and getMonth() the phone's own zone. From Beirut midnight until 03:00
 * (summer) or 02:00 (winter) UTC still names yesterday - and on the 1st, last
 * month.
 */
describe('Beirut dates on the phone', () => {
  it('is the new day at 00:30 Beirut, while UTC still says yesterday', () => {
    expect(beirutToday(new Date('2026-09-30T20:30:00Z'))).toBe('2026-09-30');
    expect(new Date('2026-09-30T21:30:00Z').toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(beirutToday(new Date('2026-09-30T21:30:00Z'))).toBe('2026-10-01');
  });

  it('keeps the month until Beirut midnight, in winter too', () => {
    expect(beirutMonth(new Date('2026-11-30T21:30:00Z'))).toBe('2026-11');
    expect(beirutMonth(new Date('2026-11-30T22:30:00Z'))).toBe('2026-12');
  });
});

/* #59 / #61: hours shown as 1.3333333333333333h, and six copies of the minutes formatter. */
describe('durations', () => {
  it('reads as hours and minutes', () => {
    expect(formatMinutes(425)).toBe('7h 5m');
    expect(formatMinutes(480)).toBe('8h');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(0)).toBe('0m');
  });

  it('rounds hours to one decimal', () => {
    expect(formatHours(80)).toBe('1.3h');
    expect(formatHours(480)).toBe('8h');
  });
});
