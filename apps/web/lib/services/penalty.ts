import type { PrismaClient } from '@prisma/client';
import { inBeirut, beirutWeekday, scheduledToUtc } from 'time';
import { rateAt, monthRangeUtc } from './payout';

// Unannounced lateness / early-leave penalty.
//   penalty hours = min(4, floor(minutesLate / 15))
// i.e. under 15 min late is free (grace), then 1 hour docked per 15-min block,
// capped at 4 hours. Same rule mirrored for leaving before the scheduled end.
const BLOCK_MIN = 15;
const MAX_HOURS = 4;

export function penaltyHours(minutes: number): number {
  if (minutes < BLOCK_MIN) return 0;
  return Math.min(MAX_HOURS, Math.floor(minutes / BLOCK_MIN));
}

export type PenaltyKind = 'LATE' | 'EARLY_LEAVE';

export interface PenaltyItem {
  date: string; // YYYY-MM-DD (Beirut)
  kind: PenaltyKind;
  minutes: number; // minutes late / early
  hours: number; // penalty hours (1..4)
  rate_cent: number; // hourly rate applied
  amount_cent: number; // hours * rate_cent
  waived: boolean;
}

interface PunchLite {
  kind: 'IN' | 'OUT';
  at: Date;
}
interface ScheduleLite {
  start_time: string;
  end_time: string;
}
interface OverrideLite {
  kind: 'DAY_OFF' | 'TIME_CHANGE';
  start_time: string | null;
  end_time: string | null;
}
interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

function nextDateStr(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const nd = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return nd.toISOString().slice(0, 10);
}

/**
 * Compute late / early-leave penalties for one user over a set of punches,
 * given their weekly schedule, date overrides, rate history and any waivers.
 * Pure — no DB. The current Beirut day is skipped for early-leave (the shift
 * may not be finished yet); lateness on the current day is still final.
 */
export function computePenalties(args: {
  punches: PunchLite[];
  schedulesByWeekday: Map<number, ScheduleLite>;
  overridesByDate: Map<string, OverrideLite>;
  rateChanges: RateChangeLite[];
  waivedKeys: Set<string>; // `${date}|${kind}`
  now?: Date;
}): PenaltyItem[] {
  const now = args.now ?? new Date();

  // All punches, chronological — used to find a shift's closing OUT even when it
  // lands on the next calendar day (overnight shifts).
  const allSorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Group punches by Beirut calendar day (a shift belongs to its arrival day).
  const byDay = new Map<string, PunchLite[]>();
  for (const p of args.punches) {
    const day = inBeirut(p.at).date;
    const arr = byDay.get(day) ?? byDay.set(day, []).get(day)!;
    arr.push(p);
  }

  const items: PenaltyItem[] = [];

  for (const [date, dayPunches] of byDay) {
    const override = args.overridesByDate.get(date);
    if (override?.kind === 'DAY_OFF') continue; // not scheduled to work

    const weekday = beirutWeekday(dayPunches[0]!.at);
    const schedule = args.schedulesByWeekday.get(weekday);

    const effStart =
      override?.kind === 'TIME_CHANGE' ? override.start_time ?? schedule?.start_time : schedule?.start_time;
    const effEnd =
      override?.kind === 'TIME_CHANGE' ? override.end_time ?? schedule?.end_time : schedule?.end_time;
    if (!effStart && !effEnd) continue; // no scheduled shift this day

    const sorted = [...dayPunches].sort((a, b) => a.at.getTime() - b.at.getTime());
    const firstIn = sorted.find((p) => p.kind === 'IN');
    if (!firstIn) continue; // no arrival that day → nothing to measure against

    const schedStartUtc = effStart ? scheduledToUtc(date, effStart) : null;

    // LATE — first arrival vs scheduled start.
    if (schedStartUtc) {
      const lateMin = Math.floor((firstIn.at.getTime() - schedStartUtc.getTime()) / 60_000);
      const hours = penaltyHours(lateMin);
      if (hours > 0) {
        const rate = rateAt(args.rateChanges, firstIn.at);
        items.push({
          date,
          kind: 'LATE',
          minutes: lateMin,
          hours,
          rate_cent: rate,
          amount_cent: hours * rate,
          waived: args.waivedKeys.has(`${date}|LATE`),
        });
      }
    }

    // EARLY_LEAVE — the shift's closing OUT vs scheduled end. Works for overnight
    // shifts (the OUT can be on the next calendar day). Only evaluated once the
    // shift is actually over (scheduled end is in the past).
    if (effEnd) {
      let schedEndUtc = scheduledToUtc(date, effEnd);
      // Overnight shift (end <= start): the scheduled end is the next day.
      if (schedStartUtc && schedEndUtc.getTime() <= schedStartUtc.getTime()) {
        schedEndUtc = scheduledToUtc(nextDateStr(date), effEnd);
      }
      if (schedEndUtc.getTime() <= now.getTime()) {
        // The closing OUT is the last OUT between arrival and a grace window past
        // scheduled end (allows overtime); the grace lets it cross midnight.
        const graceEndMs = schedEndUtc.getTime() + 6 * 60 * 60 * 1000;
        const shiftPunches = allSorted.filter(
          (p) => p.at.getTime() >= firstIn.at.getTime() && p.at.getTime() <= graceEndMs,
        );
        const last = shiftPunches[shiftPunches.length - 1];
        if (last && last.kind === 'OUT') {
          const earlyMin = Math.floor((schedEndUtc.getTime() - last.at.getTime()) / 60_000);
          const hours = penaltyHours(earlyMin);
          if (hours > 0) {
            const rate = rateAt(args.rateChanges, last.at);
            items.push({
              date,
              kind: 'EARLY_LEAVE',
              minutes: earlyMin,
              hours,
              rate_cent: rate,
              amount_cent: hours * rate,
              waived: args.waivedKeys.has(`${date}|EARLY_LEAVE`),
            });
          }
        }
      }
    }
  }

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind.localeCompare(b.kind)));
  return items;
}

/** Load everything needed and compute this user's penalties for a month. */
export async function penaltiesForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<PenaltyItem[]> {
  const { start, end } = monthRangeUtc(month);
  const [punches, schedules, overrides, rateChanges, waivers] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: userId },
      select: { weekday: true, start_time: true, end_time: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, kind: true, start_time: true, end_time: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { rate_cent: true, effective_from: true },
    }),
    db.penaltyWaiver.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, kind: true },
    }),
  ]);

  const schedulesByWeekday = new Map<number, ScheduleLite>();
  for (const s of schedules) schedulesByWeekday.set(s.weekday, { start_time: s.start_time, end_time: s.end_time });

  const overridesByDate = new Map<string, OverrideLite>();
  for (const o of overrides) {
    overridesByDate.set(o.date.toISOString().slice(0, 10), {
      kind: o.kind as 'DAY_OFF' | 'TIME_CHANGE',
      start_time: o.start_time,
      end_time: o.end_time,
    });
  }

  const waivedKeys = new Set<string>();
  for (const w of waivers) waivedKeys.add(`${w.date.toISOString().slice(0, 10)}|${w.kind}`);

  return computePenalties({
    punches: punches as PunchLite[],
    schedulesByWeekday,
    overridesByDate,
    rateChanges: rateChanges as RateChangeLite[],
    waivedKeys,
  });
}

export function sumActivePenaltiesCent(items: PenaltyItem[]): number {
  return items.reduce((s, p) => (p.waived ? s : s + p.amount_cent), 0);
}

export interface PenaltyNotice extends PenaltyItem {
  user_id: string;
  username: string;
}

// Penalties the admin has not dealt with yet, for the attention queue.
// Everything is batch-loaded across all the users at once — the dashboard polls
// every 10s, and a per-user round trip would be dozens of queries each time.
// A penalty drops off this list when it is waived (revoked) or acknowledged.
export async function pendingPenaltyNotices(
  users: Array<{ id: string; username: string }>,
  month: string,
  db: PrismaClient,
  opts: { since: string; now?: Date },
): Promise<PenaltyNotice[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);
  const { start, end } = monthRangeUtc(month);

  const [punches, schedules, overrides, rateChanges, waivers, acks] = await Promise.all([
    db.punch.findMany({
      where: { user_id: { in: ids }, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { user_id: true, kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, weekday: true, start_time: true, end_time: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true, start_time: true, end_time: true },
    }),
    db.rateChange.findMany({
      where: { user_id: { in: ids }, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    db.penaltyWaiver.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true },
    }),
    db.penaltyAck.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true },
    }),
  ]);

  const by = <T extends { user_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.user_id);
      if (list) list.push(r);
      else m.set(r.user_id, [r]);
    }
    return m;
  };
  const punchesBy = by(punches);
  const schedulesBy = by(schedules);
  const overridesBy = by(overrides);
  const ratesBy = by(rateChanges);
  const waiversBy = by(waivers);

  const ackedKeys = new Set<string>();
  for (const a of acks) ackedKeys.add(`${a.user_id}|${a.date.toISOString().slice(0, 10)}|${a.kind}`);

  const notices: PenaltyNotice[] = [];
  for (const u of users) {
    const schedulesByWeekday = new Map<number, ScheduleLite>();
    for (const s of schedulesBy.get(u.id) ?? []) {
      schedulesByWeekday.set(s.weekday, { start_time: s.start_time, end_time: s.end_time });
    }
    const overridesByDate = new Map<string, OverrideLite>();
    for (const o of overridesBy.get(u.id) ?? []) {
      overridesByDate.set(o.date.toISOString().slice(0, 10), {
        kind: o.kind as 'DAY_OFF' | 'TIME_CHANGE',
        start_time: o.start_time,
        end_time: o.end_time,
      });
    }
    const waivedKeys = new Set<string>();
    for (const w of waiversBy.get(u.id) ?? []) {
      waivedKeys.add(`${w.date.toISOString().slice(0, 10)}|${w.kind}`);
    }

    const items = computePenalties({
      punches: (punchesBy.get(u.id) ?? []) as PunchLite[],
      schedulesByWeekday,
      overridesByDate,
      rateChanges: (ratesBy.get(u.id) ?? []) as RateChangeLite[],
      waivedKeys,
      now: opts.now,
    });

    for (const p of items) {
      if (p.waived) continue;
      if (p.date < opts.since) continue;
      if (ackedKeys.has(`${u.id}|${p.date}|${p.kind}`)) continue;
      notices.push({ ...p, user_id: u.id, username: u.username });
    }
  }

  notices.sort((a, b) => (a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));
  return notices;
}
