import { describe, it, expect } from 'vitest';
import { resolveRequiredMin, type OverrideLite } from './requiredMin';
import { requiredMinFor } from '@/lib/services/coverage';

// The worker cannot import from apps/web, so resolveRequiredMin is a copy of
// the rule payroll computes from. These cases run through both implementations
// and assert the same answer, so a change to one that is not mirrored in the
// other fails here rather than in production - where the two disagreeing is
// exactly what flagged approved leave as an absence.
const CASES: Array<{ name: string; override: OverrideLite | null; weekday: number | null; expected: number }> = [
  { name: 'no override, weekday scheduled', override: null, weekday: 480, expected: 480 },
  { name: 'no override, weekday unscheduled', override: null, weekday: null, expected: 0 },
  { name: 'no override, weekday explicitly zero', override: null, weekday: 0, expected: 0 },
  { name: 'DAY_OFF beats a scheduled weekday', override: { kind: 'DAY_OFF', shift_min: null }, weekday: 480, expected: 0 },
  { name: 'DAY_OFF ignores its own shift_min', override: { kind: 'DAY_OFF', shift_min: 300 }, weekday: 480, expected: 0 },
  { name: 'HOURS_CHANGE beats the weekday', override: { kind: 'HOURS_CHANGE', shift_min: 240 }, weekday: 480, expected: 240 },
  { name: 'HOURS_CHANGE of zero owes nothing', override: { kind: 'HOURS_CHANGE', shift_min: 0 }, weekday: 480, expected: 0 },
  { name: 'HOURS_CHANGE with no hours falls back', override: { kind: 'HOURS_CHANGE', shift_min: null }, weekday: 480, expected: 480 },
];

describe('resolveRequiredMin', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.expected} min, and web agrees`, () => {
      expect(resolveRequiredMin(c.override, c.weekday)).toBe(c.expected);
      expect(requiredMinFor(c.override, c.weekday)).toBe(c.expected);
    });
  }
});
