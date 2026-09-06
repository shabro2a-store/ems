/**
 * The working-day boundary that applies to one person: theirs, or midnight.
 *
 * The worker's copy of dayStartHourFor in apps/web/lib/services/coverage.ts,
 * which is the definition of record. The worker is a separate pnpm package and
 * cannot import from apps/web; dayStart.test.ts pins the two against the same
 * table of cases, the way requiredMin.test.ts pins resolveRequiredMin.
 *
 * There is no branch fallback, and that absence is the whole design. A branch
 * cannot carry this setting: every branch that did held both a night worker who
 * needed it and day staff whom it silently moved into the previous day, and the
 * previous month. Off by default is the only default that is safe, because the
 * cost of a missing boundary is one night's hours reading oddly, while the cost
 * of an unwanted one is a shift filed in a month that then closes.
 */
export function resolveDayStartHour(
  user: { day_start_hour?: number | null } | null | undefined,
): number {
  return user?.day_start_hour ?? 0;
}
