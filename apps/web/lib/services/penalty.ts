import type { PrismaClient } from '@prisma/client';
import { rateAt, monthRangeUtc } from './payout';
import { computeCoverage, type DayCoverage, type OverrideLite, type PunchLite } from './coverage';

/**
 * Minutes docked for covering fewer than the day required.
 *
 *   shortfall <= grace -> nothing
 *   otherwise            min(2 * shortfall, workedMin)
 *
 * The grace is a threshold, not forgiveness: past it the whole shortfall is
 * doubled, exactly as an overrun past the same grace is reported in full. 16
 * minutes short of a 15-minute grace docks 32, not 2.
 *
 * The ceiling is the point. Doubling alone can exceed what the day earned and
 * start eating other days' pay, which the owner ruled unethical: the worst a
 * day can cost is the day itself, never more. It also means somebody who
 * punches in and straight back out has worked ~0 minutes and so is docked ~0 -
 * consistent with a no-show being a notice with no automatic penalty, and not
 * a hole to plug.
 */
export function penaltyMinutes(shortfallMin: number, workedMin: number, graceMin: number): number {
  if (shortfallMin <= graceMin) return 0;
  return Math.min(2 * shortfallMin, Math.max(0, workedMin));
}

// Only reached by a user with no branch; mirrors Branch.shift_grace_min's default.
const DEFAULT_GRACE_MIN = 15;

export type PenaltyKind = 'SHORTFALL';

export interface PenaltyItem {
  date: string; // YYYY-MM-DD (Beirut)
  kind: PenaltyKind;
  shortfallMin: number; // minutes short of the required coverage
  penaltyMin: number; // minutes docked for it
  rate_cent: number; // hourly rate applied
  amount_cent: number; // floor(penaltyMin * rate_cent / 60)
  waived: boolean;
}

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

/**
 * Shortfall penalties from a day's coverage. Unclosed days are skipped - their
 * hours are unknowable until the missing punch is corrected.
 */
export function shortfallPenalties(args: {
  coverage: DayCoverage[];
  rateChanges: RateChangeLite[];
  graceMin: number;
  waivedKeys: Set<string>; // `${date}|SHORTFALL`
}): PenaltyItem[] {
  const items: PenaltyItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.deltaMin >= 0) continue;
    const shortfallMin = -day.deltaMin;
    const penaltyMin = penaltyMinutes(shortfallMin, day.workedMin, args.graceMin);
    if (penaltyMin === 0) continue;
    const rate = rateAt(args.rateChanges, day.lastPunchAt);
    items.push({
      date: day.date,
      kind: 'SHORTFALL',
      shortfallMin,
      penaltyMin,
      rate_cent: rate,
      amount_cent: Math.floor((penaltyMin * rate) / 60),
      waived: args.waivedKeys.has(`${day.date}|SHORTFALL`),
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

/** Load everything needed and compute this user's penalties for a month. */
export async function penaltiesForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<PenaltyItem[]> {
  const { start, end } = monthRangeUtc(month);
  const [punches, schedules, overrides, rateChanges, waivers, user] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: userId },
      select: { weekday: true, shift_min: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, kind: true, shift_min: true },
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
    db.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { shift_grace_min: true } } },
    }),
  ]);

  const shiftMinByWeekday = new Map<number, number>();
  for (const s of schedules) shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);

  const overridesByDate = new Map<string, OverrideLite>();
  for (const o of overrides) {
    if (o.kind !== 'DAY_OFF' && o.kind !== 'HOURS_CHANGE') continue;
    overridesByDate.set(o.date.toISOString().slice(0, 10), {
      kind: o.kind,
      shift_min: o.shift_min,
    });
  }

  const waivedKeys = new Set<string>();
  for (const w of waivers) waivedKeys.add(`${w.date.toISOString().slice(0, 10)}|${w.kind}`);

  const coverage = computeCoverage({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
  });
  return shortfallPenalties({
    coverage,
    rateChanges: rateChanges as RateChangeLite[],
    graceMin: user?.branch?.shift_grace_min ?? DEFAULT_GRACE_MIN,
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

  const [punches, schedules, overrides, rateChanges, waivers, acks, userBranches] = await Promise.all([
    db.punch.findMany({
      where: { user_id: { in: ids }, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { user_id: true, kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, weekday: true, shift_min: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true, shift_min: true },
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
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, branch: { select: { shift_grace_min: true } } },
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

  const graceByUser = new Map<string, number>();
  for (const u of userBranches) graceByUser.set(u.id, u.branch?.shift_grace_min ?? DEFAULT_GRACE_MIN);

  const notices: PenaltyNotice[] = [];
  for (const u of users) {
    const shiftMinByWeekday = new Map<number, number>();
    for (const s of schedulesBy.get(u.id) ?? []) {
      shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);
    }
    const overridesByDate = new Map<string, OverrideLite>();
    for (const o of overridesBy.get(u.id) ?? []) {
      if (o.kind !== 'DAY_OFF' && o.kind !== 'HOURS_CHANGE') continue;
      overridesByDate.set(o.date.toISOString().slice(0, 10), {
        kind: o.kind,
        shift_min: o.shift_min,
      });
    }
    const waivedKeys = new Set<string>();
    for (const w of waiversBy.get(u.id) ?? []) {
      waivedKeys.add(`${w.date.toISOString().slice(0, 10)}|${w.kind}`);
    }

    const coverage = computeCoverage({
      punches: (punchesBy.get(u.id) ?? []) as PunchLite[],
      shiftMinByWeekday,
      overridesByDate,
    });
    const items = shortfallPenalties({
      coverage,
      rateChanges: (ratesBy.get(u.id) ?? []) as RateChangeLite[],
      graceMin: graceByUser.get(u.id) ?? DEFAULT_GRACE_MIN,
      waivedKeys,
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
