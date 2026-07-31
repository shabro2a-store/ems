import { PrismaClient } from '@prisma/client';
import { todayInBeirut, scheduledToUtc, beirutWeekday } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface MissedCheckoutOpts {
  db?: PrismaClient;
  now?: Date;
  notifier: Notifier;
}

export interface MissedCheckoutResult {
  flags_created: number;
  notified: number;
}

export async function runMissedCheckout(
  opts: MissedCheckoutOpts,
): Promise<MissedCheckoutResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const today = todayInBeirut(now);
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const yesterday = todayInBeirut(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const yesterdayDate = new Date(`${yesterday}T00:00:00.000Z`);
  const wdToday = beirutWeekday(now);
  const wdYesterday = beirutWeekday(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  // A shift's END falls "today" if it's a today shift that ends the same day, OR
  // a yesterday shift that runs overnight (end_time <= start_time) into today.
  const schedules = await db.schedule.findMany({
    where: { weekday: { in: [wdToday, wdYesterday] } },
    include: { user: { include: { branch: true } } },
  });

  // Approved exceptions for the shift's start day (today or yesterday): DAY_OFF
  // skips the check; TIME_CHANGE shifts the effective end.
  const overrides = await db.scheduleOverride.findMany({
    where: { date: { in: [todayDate, yesterdayDate] } },
    select: { user_id: true, date: true, kind: true, end_time: true },
  });
  const overrideByKey = new Map(
    overrides.map((o) => [`${o.user_id}|${o.date.toISOString().slice(0, 10)}`, o]),
  );

  let flags_created = 0;
  let notified = 0;

  for (const s of schedules) {
    const overnight = s.end_time <= s.start_time;
    const endsToday =
      (s.weekday === wdToday && !overnight) || (s.weekday === wdYesterday && overnight);
    if (!endsToday) continue;
    // The shift started today (same-day) or yesterday (overnight).
    const shiftStartDay = s.weekday === wdToday ? today : yesterday;
    const override = overrideByKey.get(`${s.user_id}|${shiftStartDay}`);
    if (override?.kind === 'DAY_OFF') continue;
    const effEnd = override?.kind === 'TIME_CHANGE' && override.end_time ? override.end_time : s.end_time;
    const endUtc = scheduledToUtc(today, effEnd);
    const triggerAt = new Date(endUtc.getTime() + 35 * 60_000);
    if (now.getTime() < triggerAt.getTime()) continue;

    const lastIn = await db.punch.findFirst({
      where: { user_id: s.user_id, kind: 'IN' },
      orderBy: { at: 'desc' },
    });
    if (!lastIn) continue;
    const laterOut = await db.punch.findFirst({
      where: { user_id: s.user_id, kind: 'OUT', at: { gt: lastIn.at } },
    });
    if (laterOut) continue;

    const existing = await db.flag.findFirst({
      where: { kind: 'MISSED_CHECKOUT', user_id: s.user_id, created_at: { gte: todayDate } },
    });
    if (existing) continue;

    const flag = await db.flag.create({
      data: {
        kind: 'MISSED_CHECKOUT',
        user_id: s.user_id,
        branch_id: s.user.branch_id,
        context_json: { scheduled_end: effEnd, since_min: Math.floor((now.getTime() - endUtc.getTime()) / 60_000) },
      },
    });
    flags_created += 1;

    await opts.notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'missed_checkout',
      context: {
        user: { id: s.user_id, username: s.user.username },
        branch: s.user.branch ? { id: s.user.branch.id, name: s.user.branch.name } : null,
        message: `Employee ${s.user.username}${s.user.branch ? `, ${s.user.branch.name}` : ''} is still clocked in 35 min past shift end (8h+ into shift). Overtime, or forgot to punch out?`,
        flag_id: flag.id,
      },
    });
    notified += 1;
  }

  return { flags_created, notified };
}