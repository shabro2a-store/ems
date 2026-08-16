import { PrismaClient } from '@prisma/client';
import { todayInBeirut, scheduledToUtc, beirutWeekday } from 'time';
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

export async function runWatchedDetector(
  opts: WatchedDetectorOpts = {},
): Promise<WatchedDetectorResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const today = todayInBeirut(now);
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const wd = beirutWeekday(now);

  const schedules = await db.schedule.findMany({
    where: { weekday: wd },
    include: { user: { include: { branch: true } } },
  });

  // Approved exceptions for today: DAY_OFF is skipped; TIME_CHANGE shifts the
  // effective start we measure lateness against.
  const overrides = await db.scheduleOverride.findMany({
    where: { date: todayDate },
    select: { user_id: true, kind: true, start_time: true },
  });
  const overrideByUser = new Map(overrides.map((o) => [o.user_id, o]));

  let flags_created = 0;
  let skipped_day_off = 0;
  const users_scanned = schedules.length;

  for (const s of schedules) {
    if (!s.user.is_active) continue;
    // An hours-based schedule (Task 8) carries no clock window to detect
    // against - Task 10 migrates this job to shift_min. Until then, skip
    // rather than let scheduledToUtc silently turn a null into Invalid Date.
    if (s.start_time == null) continue;
    const override = overrideByUser.get(s.user_id);
    if (override?.kind === 'DAY_OFF') {
      skipped_day_off += 1;
      continue;
    }
    const effStart = override?.kind === 'TIME_CHANGE' && override.start_time ? override.start_time : s.start_time;
    const startUtc = scheduledToUtc(today, effStart);
    const triggerAt = new Date(startUtc.getTime() + 30 * 60_000);
    if (now.getTime() < triggerAt.getTime()) continue;

    const startOfDay = new Date(startUtc);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60_000);

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
    // guard stop matching, so the next run (a minute later) created a duplicate
    // and the notice appeared to come back by itself.
    const existing = await db.flag.findFirst({
      where: { kind: 'WATCHED', user_id: s.user_id, created_at: { gte: startOfDay, lt: endOfDay } },
    });
    if (existing) continue;

    const since_min = Math.max(0, Math.floor((now.getTime() - startUtc.getTime()) / 60_000));
    await db.flag.create({
      data: {
        kind: 'WATCHED',
        user_id: s.user_id,
        branch_id: s.user.branch_id,
        context_json: { scheduled_start: s.start_time, since_min },
      },
    });
    flags_created += 1;
  }

  return { flags_created, users_scanned, skipped_day_off };
}