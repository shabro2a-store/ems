export interface OverrideLite {
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  shift_min: number | null;
}

/**
 * How many minutes one date required, for the two jobs that judge a day.
 *
 * This is the worker's copy of requiredMinFor in
 * apps/web/lib/services/coverage.ts, which payroll computes from and which is
 * the definition of record. The worker is a separate pnpm package and cannot
 * import from apps/web; requiredMin.test.ts pins the two against the same
 * table of cases so they cannot drift apart silently.
 */
export function resolveRequiredMin(
  override: OverrideLite | null | undefined,
  weekdayShiftMin: number | null | undefined,
): number {
  if (override?.kind === 'DAY_OFF') return 0;
  if (override?.kind === 'HOURS_CHANGE' && override.shift_min !== null) return override.shift_min;
  return weekdayShiftMin ?? 0;
}
