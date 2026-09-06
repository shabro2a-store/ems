/**
 * The working-day boundary that applies to one person: their own if the owner
 * set one, otherwise their branch's, otherwise midnight.
 *
 * The worker's copy of dayStartHourFor in apps/web/lib/services/coverage.ts,
 * which is the definition of record. The worker is a separate pnpm package and
 * cannot import from apps/web; dayStart.test.ts pins the two against the same
 * table of cases, the way requiredMin.test.ts pins resolveRequiredMin.
 *
 * The order matters and is not arbitrary: a person's own setting beats their
 * branch's, because the whole reason this column exists is that one branch
 * holds both a night worker who needs the boundary and day staff whom it
 * silently moves into the previous day - and the previous month.
 */
export function resolveDayStartHour(
  user:
    | {
        day_start_hour?: number | null;
        branch?: { day_start_hour?: number | null } | null;
      }
    | null
    | undefined,
): number {
  return user?.day_start_hour ?? user?.branch?.day_start_hour ?? 0;
}
