import { describe, it, expect } from 'vitest';
import { dayStartHourFor } from '@/lib/services/coverage';
import { resolveDayStartHour } from './dayStart';

/*
 * The worker cannot import from apps/web, so the boundary rule exists twice.
 * Every case runs through BOTH, because two copies that drift are worse than
 * one wrong one: payroll would file a shift on one day and the absence sweep
 * would judge it on another, and nothing would look broken from either side.
 */
const CASES: Array<[string, Parameters<typeof resolveDayStartHour>[0], number]> = [
  ['nothing set anywhere is midnight', { branch: null }, 0],
  ['a null user with no row at all', null, 0],
  ['undefined', undefined, 0],
  ["the branch's, when the user has none", { day_start_hour: null, branch: { day_start_hour: 4 } }, 4],
  ["the user's own beats the branch's", { day_start_hour: 0, branch: { day_start_hour: 4 } }, 0],
  ['and the other way round too', { day_start_hour: 4, branch: { day_start_hour: 0 } }, 4],
  ['a user with no branch at all', { day_start_hour: 3, branch: null }, 3],
  ['a branch that has been removed', { day_start_hour: null, branch: null }, 0],
];

describe('the working-day boundary that applies to one person', () => {
  for (const [name, input, expected] of CASES) {
    it(name, () => {
      expect(resolveDayStartHour(input)).toBe(expected);
      expect(dayStartHourFor(input)).toBe(expected);
    });
  }

  it('treats an explicit 0 as a real answer, not a missing one', () => {
    // The case the whole column exists for. Bilal sits at a branch set to 4 and
    // needs midnight; `||` instead of `??` here would silently give him 4 back
    // and put his 00:24 check-in in the previous month all over again.
    const bilal = { day_start_hour: 0, branch: { day_start_hour: 4 } };
    expect(resolveDayStartHour(bilal)).toBe(0);
    expect(dayStartHourFor(bilal)).toBe(0);
  });
});
