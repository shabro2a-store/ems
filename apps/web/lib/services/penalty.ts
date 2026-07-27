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
  const todayStr = inBeirut(now).date;

  // Group punches by Beirut calendar day.
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

    // EARLY_LEAVE — final departure vs scheduled end. Skip the current day
    // (the shift may not be over) and only when the day ended on an OUT.
    if (effEnd && date !== todayStr) {
      const lastPunch = sorted[sorted.length - 1]!;
      const lastOut = [...sorted].reverse().find((p) => p.kind === 'OUT');
      if (lastOut && lastPunch.kind === 'OUT') {
        let schedEndUtc = scheduledToUtc(date, effEnd);
        // Overnight shift (end <= start): the scheduled end is the next day.
        if (schedStartUtc && schedEndUtc.getTime() <= schedStartUtc.getTime()) {
          schedEndUtc = scheduledToUtc(nextDateStr(date), effEnd);
        }
        const earlyMin = Math.floor((schedEndUtc.getTime() - lastOut.at.getTime()) / 60_000);
        const hours = penaltyHours(earlyMin);
        if (hours > 0) {
          const rate = rateAt(args.rateChanges, lastOut.at);
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
