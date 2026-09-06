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
  ['nobody configured is midnight', {}, 0],
  ['a null user with no row at all', null, 0],
  ['undefined', undefined, 0],
  ['an explicit hour is theirs', { day_start_hour: 4 }, 4],
  ['an explicit 0 is midnight', { day_start_hour: 0 }, 0],
  ['null is midnight, not a branch lookup', { day_start_hour: null }, 0],
];

describe('the working-day boundary that applies to one person', () => {
  for (const [name, input, expected] of CASES) {
    it(name, () => {
      expect(resolveDayStartHour(input)).toBe(expected);
      expect(dayStartHourFor(input)).toBe(expected);
    });
  }

  it('treats an explicit 0 as a real answer, not a missing one', () => {
    // `||` instead of `??` would read a deliberate midnight as "unset". Today
    // both land on 0 so nothing breaks, but the moment any fallback is added
    // back this is the test that catches it turning a choice into a default.
    expect(resolveDayStartHour({ day_start_hour: 0 })).toBe(0);
    expect(dayStartHourFor({ day_start_hour: 0 })).toBe(0);
  });

  it('ignores a branch that still carries an hour', () => {
    // The column still exists on Branch for history, and the deploy that moved
    // this setting onto people did not clear it. If anything ever reads it
    // again, every unconfigured employee at that branch silently inherits a
    // boundary nobody chose - which is the whole failure this replaced.
    const atBranchWithFour = { day_start_hour: null, branch: { day_start_hour: 4 } };
    expect(resolveDayStartHour(atBranchWithFour)).toBe(0);
    expect(dayStartHourFor(atBranchWithFour)).toBe(0);
  });
});
