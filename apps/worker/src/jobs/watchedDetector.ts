import { PrismaClient } from '@prisma/client';
import { todayInBeirut, todayInBeirutDateRange, beirutWeekday, previousBeirutDate } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';
import { resolveRequiredMin } from './requiredMin';

export interface WatchedDetectorOpts {
  db?: PrismaClient;
  now?: Date;
  notifier?: Notifier;
}

export interface WatchedDetectorResult {
  flags_created: number;
  users_scanned: number;
  skipped_off: number;
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
  // From the calendar, not from now-24h: on the morning after a short DST day
  // that arithmetic lands two days back and the short day is never judged.
  const yesterday = previousBeirutDate(todayInBeirut(now));
  const { startUtc: startOfDay, endUtc: endOfDay } = todayInBeirutDateRange(yesterday);
  const wd = beirutWeekday(startOfDay);
  const overrideDate = new Date(`${yesterday}T00:00:00.000Z`);

  const schedules = await db.schedule.findMany({
    where: { weekday: wd, shift_min: { gt: 0 } },
    include: { user: { include: { branch: true } } },
  });

  // Every override for the day being judged, not just DAY_OFF: approving a
  // full shift of time off writes an HOURS_CHANGE with shift_min 0, which owes
  // exactly as little as a day off. Filtering on kind alone flagged those
  // people absent on leave the owner had just granted.
  const overrides = await db.scheduleOverride.findMany({
    where: { date: overrideDate },
    select: { user_id: true, kind: true, shift_min: true },
  });
  const overrideByUser = new Map(overrides.map((o) => [o.user_id, o]));

  let flags_created = 0;
  let skipped_off = 0;
  const users_scanned = schedules.length;

  for (const s of schedules) {
    if (!s.user.is_active) continue;
    const requiredMin = resolveRequiredMin(overrideByUser.get(s.user_id), s.shift_min);
    if (requiredMin === 0) {
      skipped_off += 1;
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
        context_json: { shift_min: requiredMin, date: yesterday },
      },
    });
    flags_created += 1;
  }

  return { flags_created, users_scanned, skipped_off };
}
