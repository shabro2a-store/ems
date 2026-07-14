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

  const dayOffs = await db.scheduleOverride.findMany({
    where: { date: todayDate, kind: 'DAY_OFF' },
    select: { user_id: true },
  });
  const dayOffSet = new Set(dayOffs.map((d) => d.user_id));

  let flags_created = 0;
  let skipped_day_off = 0;
  const users_scanned = schedules.length;

  for (const s of schedules) {
    if (!s.user.is_active) continue;
    if (dayOffSet.has(s.user_id)) {
      skipped_day_off += 1;
      continue;
    }
    const startUtc = scheduledToUtc(today, s.start_time);
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

    const existing = await db.flag.findFirst({
      where: { kind: 'WATCHED', user_id: s.user_id, notified_at: null, created_at: { gte: startOfDay, lt: endOfDay } },
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