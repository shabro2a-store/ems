import { PrismaClient } from '@prisma/client';
import { todayInBeirut, todayInBeirutDateRange, beirutWeekday } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface WatchedDetectorOpts {
  db?: PrismaClient;
  now?: Date;
  notifier?: Notifier;
}

export interface WatchedDetectorResult {
  flags_created: number;
  users_scanned: number;
  skipped_day_off: number;
}

// There is no scheduled clock time to be "late" against anymore, only a
// required number of hours - so absence can only be judged once the day
// that just ended is fully over. Looking back at the closed Beirut day means
// an employee who starts at 23:00 has already punched by the time this runs,
// so a late-night start is never misread as a no-show.
export async function runWatchedDetector(
  opts: WatchedDetectorOpts = {},
): Promise<WatchedDetectorResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const yesterdayInstant = new Date(now.getTime() - 24 * 60 * 60_000);
  const yesterday = todayInBeirut(yesterdayInstant);
  const wd = beirutWeekday(yesterdayInstant);
  const { startUtc: startOfDay, endUtc: endOfDay } = todayInBeirutDateRange(yesterday);
  const overrideDate = new Date(`${yesterday}T00:00:00.000Z`);

  const schedules = await db.schedule.findMany({
    where: { weekday: wd, shift_min: { gt: 0 } },
    include: { user: { include: { branch: true } } },
  });

  // Approved DAY_OFF overrides for the day being judged.
  const overrides = await db.scheduleOverride.findMany({
    where: { date: overrideDate, kind: 'DAY_OFF' },
    select: { user_id: true },
  });
  const dayOffUsers = new Set(overrides.map((o) => o.user_id));

  let flags_created = 0;
  let skipped_day_off = 0;
  const users_scanned = schedules.length;

  for (const s of schedules) {
    if (!s.user.is_active) continue;
    if (dayOffUsers.has(s.user_id)) {
      skipped_day_off += 1;
      continue;
    }

    const hasPunch = await db.punch.findFirst({
      where: {
        user_id: s.user_id,
        at: { gte: startOfDay, lt: endOfDay },
      },
      select: { id: true },
    });
    if (hasPunch) continue;

    // One flag per user per day, regardless of whether it has been dealt with.
    // Filtering on an unresolved flag here meant that dismissing one made this
    // guard stop matching, so the next run created a duplicate and the notice
    // appeared to come back by itself.
    const existing = await db.flag.findFirst({
      where: { kind: 'WATCHED', user_id: s.user_id, created_at: { gte: startOfDay, lt: endOfDay } },
    });
    if (existing) continue;

    await db.flag.create({
      data: {
        kind: 'WATCHED',
        user_id: s.user_id,
        branch_id: s.user.branch_id,
        context_json: { shift_min: s.shift_min, date: yesterday },
      },
    });
    flags_created += 1;
  }

  return { flags_created, users_scanned, skipped_day_off };
}
