import { PrismaClient } from '@prisma/client';
import { beirutWeekday, previousBeirutDate, todayInBeirut } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';
import { resolveRequiredMin } from './requiredMin';
import { resolveDayStartHour, resolveWorkingDays } from './dayStart';

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
// required number of hours - so absence can only be judged once the working day
// that just ended is fully over.
//
// That day is the branch's working day, not the calendar day. Everything that
// decides hours - payroll, penalties, overtime, blocked credit, missed checkout,
// auto-close - asks the rest rule which working day a
// punch belongs to; this job used to ask the calendar instead. Once a branch
// moved its boundary off midnight the two stopped naming the same day for
// anyone who clocks in near it, and a night worker got judged on a day his
// punches were never going to be in: the night he actually skipped went
// unreported, because the PREVIOUS night's punches sat inside the calendar day
// being examined, and the night he did work was flagged as an absence, because
// its punches had not landed in the calendar day yet.
export async function runWatchedDetector(
  opts: WatchedDetectorOpts = {},
): Promise<WatchedDetectorResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  // One judged day for everybody, and no boundary anywhere.
  //
  // A working day is now named by the calendar date of the arrival that opened
  // it (moved forward only when an earlier shift already claimed that date), so
  // every shift labelled D has started by the end of D - labels never move
  // backwards. The day that just ended is therefore simply yesterday, for
  // everyone, whatever hours they keep.
  //
  // From the calendar, not now-24h: on the morning after a short DST day that
  // arithmetic lands two days back and the short day is never judged.
  const judged = previousBeirutDate(todayInBeirut(now));
  // From the date itself at midday, where no DST transition can reach it.
  const wd = beirutWeekday(new Date(`${judged}T12:00:00.000Z`));
  const overrideDate = new Date(`${judged}T00:00:00.000Z`);

  let flags_created = 0;
  let skipped_off = 0;
  let users_scanned = 0;

  {
    const mine = await db.schedule.findMany({
      where: { weekday: wd, shift_min: { gt: 0 } },
      include: { user: { include: { branch: true } } },
    });
    if (mine.length === 0) return { flags_created, users_scanned, skipped_off };
    users_scanned += mine.length;

    // Every override for the day being judged, not just DAY_OFF: approving a
    // full shift of time off writes an HOURS_CHANGE with shift_min 0, which owes
    // exactly as little as a day off. Filtering on kind alone flagged those
    // people absent on leave the owner had just granted.
    const overrides = await db.scheduleOverride.findMany({
      where: { date: overrideDate },
      select: { user_id: true, kind: true, shift_min: true },
    });
    const overrideByUser = new Map(overrides.map((o) => [o.user_id, o]));

    // One flag per user per working day. Keyed by the day the flag is ABOUT,
    // read out of the flag itself, rather than by when the row happened to be
    // written: the job runs after the day it judges has ended, so a flag's
    // created_at falls in the NEXT day's window and the guard matched the wrong
    // day - somebody absent two days running was reported for the first only.
    const seen = new Set<string>();
    for (const f of await db.flag.findMany({
      where: { kind: 'WATCHED', user_id: { in: mine.map((s) => s.user_id) } },
      select: { user_id: true, context_json: true },
    })) {
      const date = (f.context_json as { date?: unknown } | null)?.date;
      if (typeof date === 'string') seen.add(`${f.user_id}|${date}`);
    }

    for (const s of mine) {
      if (!s.user.is_active) continue;
      const requiredMin = resolveRequiredMin(overrideByUser.get(s.user_id), s.shift_min);
      if (requiredMin === 0) {
        skipped_off += 1;
        continue;
      }

      // Did a WORKING DAY named `judged` ever open for them?
      //
      // Asked of the labels, not of a time window. A window cannot answer it:
      // a night shift's checkout lands inside the following day, and counting
      // that as attendance is exactly how a skipped night hid behind the night
      // before it. The label is the same one payroll files the shift under, so
      // "was this day worked" and "was this day paid" cannot disagree.
      //
      // Three days either side, because a shift labelled `judged` may have
      // started the evening before it and may still be running.
      const around = await db.punch.findMany({
        where: {
          user_id: s.user_id,
          at: {
            gte: new Date(`${judged}T00:00:00.000Z`).getTime() - 3 * 86_400_000 > 0
              ? new Date(new Date(`${judged}T00:00:00.000Z`).getTime() - 3 * 86_400_000)
              : new Date(0),
            lte: new Date(new Date(`${judged}T00:00:00.000Z`).getTime() + 3 * 86_400_000),
          },
        },
        orderBy: { at: 'asc' },
        select: { kind: true, at: true },
      });
      const labels = resolveWorkingDays(around, resolveDayStartHour(s.user));
      if (around.some((p, i) => p.kind === 'IN' && labels[i] === judged)) continue;

      if (seen.has(`${s.user_id}|${judged}`)) continue;

      await db.flag.create({
        data: {
          kind: 'WATCHED',
          user_id: s.user_id,
          branch_id: s.user.branch_id,
          context_json: { shift_min: requiredMin, date: judged },
        },
      });
      flags_created += 1;
    }
  }

  return { flags_created, users_scanned, skipped_off };
}
