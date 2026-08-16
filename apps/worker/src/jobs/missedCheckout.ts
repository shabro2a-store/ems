import { PrismaClient } from '@prisma/client';
import { todayInBeirut, todayInBeirutDateRange, beirutWeekday } from 'time';
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
  const { startUtc: todayStart } = todayInBeirutDateRange(todayInBeirut(now));

  // Not bounded to today/yesterday: an hours-based shift has no fixed end
  // time, so a check-in can still be open from further back. Scanning every
  // weekday's shift_min is the only way a still-open check-in keeps getting
  // re-flagged (once per day, via the guard below) for as long as it stays open.
  const schedules = await db.schedule.findMany({
    where: { shift_min: { gt: 0 } },
    include: { user: { include: { branch: true } } },
  });

  let flags_created = 0;
  let notified = 0;

  for (const s of schedules) {
    if (s.shift_min == null) continue;
    const shiftMin = s.shift_min;

    const lastIn = await db.punch.findFirst({
      where: { user_id: s.user_id, kind: 'IN' },
      orderBy: { at: 'desc' },
    });
    if (!lastIn) continue;
    const laterOut = await db.punch.findFirst({
      where: { user_id: s.user_id, kind: 'OUT', at: { gt: lastIn.at } },
    });
    if (laterOut) continue;

    // shift_min is keyed by weekday, so an open check-in is only judged
    // against the schedule row for the weekday it actually started on.
    if (beirutWeekday(lastIn.at) !== s.weekday) continue;

    const graceMin = s.user.branch?.overtime_grace_min ?? 15;
    const elapsedMin = Math.floor((now.getTime() - lastIn.at.getTime()) / 60_000);
    if (elapsedMin <= shiftMin + graceMin) continue;

    const existing = await db.flag.findFirst({
      where: { kind: 'MISSED_CHECKOUT', user_id: s.user_id, created_at: { gte: todayStart } },
    });
    if (existing) continue;

    const overMin = Math.max(0, elapsedMin - shiftMin);
    const flag = await db.flag.create({
      data: {
        kind: 'MISSED_CHECKOUT',
        user_id: s.user_id,
        branch_id: s.user.branch_id,
        context_json: { shift_min: shiftMin, over_min: overMin },
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
        message: `Employee ${s.user.username}${s.user.branch ? `, ${s.user.branch.name}` : ''} is still clocked in past their ${Math.round(shiftMin / 60)}h shift. Overtime, or forgot to punch out?`,
        flag_id: flag.id,
      },
    });
    notified += 1;
  }

  return { flags_created, notified };
}
