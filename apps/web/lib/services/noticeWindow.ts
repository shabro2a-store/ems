export interface DatedNotice {
  user_id: string;
  username: string;
  date: string; // YYYY-MM-DD (Beirut)
}

/**
 * The YYYY-MM months a [since, today] lookback actually touches, oldest first.
 *
 * pendingPenaltyNotices and pendingOvertimeNotices window their punch queries by
 * one month, so asking them only for the current month while claiming a seven-day
 * lookback makes the lookback dead across the boundary: on the 1st, the previous
 * month's days are outside every query that runs. For penalties that quietly
 * hides an applied penalty; for overtime it is worse, because pending means paid,
 * so an overrun on the 30th auto-approves and the owner never sees it.
 */
export function lookbackMonths(since: string, today: string): string[] {
  const start = since.slice(0, 7);
  const end = today.slice(0, 7);
  if (start >= end) return [end];

  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  // A lookback is days, not years; the bound only stops a malformed input from
  // spinning forever.
  for (let i = 0; i < 24; i++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key === end) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Flatten per-month notice batches into one list, newest day first.
 *
 * Later batches win on a collision. A Beirut day can appear in two UTC month
 * windows - Beirut midnight is 21:00 or 22:00 UTC the day before - so the 1st of
 * a month can be computed twice from different halves of its punches. The newer
 * window holds the larger part of that day, so it is the one to keep.
 */
export function mergeNotices<T extends DatedNotice>(batches: T[][]): T[] {
  const byUserDay = new Map<string, T>();
  for (const batch of batches) {
    for (const notice of batch) byUserDay.set(`${notice.user_id}|${notice.date}`, notice);
  }
  return [...byUserDay.values()].sort((a, b) =>
    a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date),
  );
}
