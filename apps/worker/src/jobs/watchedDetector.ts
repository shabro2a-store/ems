import { PrismaClient } from '@prisma/client';
import { beirutWeekday, previousBeirutDate, shiftDateOf, shiftDayRange } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';
import { resolveRequiredMin } from './requiredMin';
import { resolveDayStartHour } from './dayStart';

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
// auto-close - reads Branch.day_start_hour and asks shiftDateOf which day a
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

  const [branches, ownBoundaries] = await Promise.all([
    db.branch.findMany({ select: { id: true, day_start_hour: true } }),
    // Employees whose own boundary overrides their branch's. Their hour has to
    // be in the set even when no branch uses it, or the pass that would judge
    // them never runs and they are simply never checked for absence.
    db.user.findMany({
      where: { day_start_hour: { not: null } },
      select: { day_start_hour: true },
    }),
  ]);

  // Two people can be part-way through different working days at one instant,
  // with different days to judge - so each boundary in use is judged on its own
  // pass. Midnight is always in the set: it is what somebody with no branch, or
  // whose branch has been removed, falls back to.
  const boundaries = [
    ...new Set<number>([
      0,
      ...branches.map((b) => b.day_start_hour ?? 0),
      ...ownBoundaries.map((u) => u.day_start_hour ?? 0),
    ]),
  ].sort((a, b) => a - b);

  let flags_created = 0;
  let skipped_off = 0;
  let users_scanned = 0;

  for (const dayStartHour of boundaries) {
    // shiftDateOf names the working day in progress, so the one before it is the
    // last one that has fully ended - via the calendar, never now-24h, which
    // lands on the wrong date the morning after a short DST day.
    const judged = previousBeirutDate(shiftDateOf(now, dayStartHour));
    const { startUtc, endUtc } = shiftDayRange(judged, dayStartHour);
    // From the date itself at midday, where no boundary or DST transition can
    // reach it - the same way shiftWeekdayOf resolves a working day's weekday.
    const wd = beirutWeekday(new Date(`${judged}T12:00:00.000Z`));
    const overrideDate = new Date(`${judged}T00:00:00.000Z`);

    const scheduled = await db.schedule.findMany({
      where: { weekday: wd, shift_min: { gt: 0 } },
      include: { user: { include: { branch: true } } },
    });
    // Only the people this boundary actually governs. Everyone else is in this
    // result set because the weekday is queried globally, but their working day
    // starts at a different hour and is judged on its own pass. Resolved per
    // PERSON, so an employee whose own boundary differs from their branch's is
    // judged on theirs - which is the whole point of the override.
    const mine = scheduled.filter((s) => resolveDayStartHour(s.user) === dayStartHour);
    if (mine.length === 0) continue;
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

      // An ARRIVAL in the window, not any punch. A working day is made by the
      // punch that starts it - that is the rule computeCoverage builds days on,
      // and the reason a shift belongs to the day it clocked in. A night shift
      // straddles the boundary, so the checkout of the PREVIOUS day's shift
      // lands inside this one; counting it as attendance is how a skipped night
      // hid behind the night before it.
      const arrived = await db.punch.findFirst({
        where: {
          user_id: s.user_id,
          kind: 'IN',
          at: { gte: startUtc, lt: endUtc },
        },
        select: { id: true },
      });
      if (arrived) continue;

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
