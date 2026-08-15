import type { PrismaClient } from '@prisma/client';
import { rateAt, monthRangeUtc } from './payout';
import { computeCoverage, type DayCoverage, type OverrideLite, type PunchLite } from './coverage';

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

export interface OvertimeItem {
  date: string; // YYYY-MM-DD (Beirut)
  overtimeMin: number;
  rate_cent: number;
  amount_cent: number; // already inside gross pay - pairHours pays every minute
  decision: 'ACCEPTED' | 'REVOKED' | null; // null means pending, and pending is paid
}

/**
 * Days that ran past their required hours by more than the branch grace. The
 * grace only decides whether the owner is told; a reported overrun reports all
 * of it, not the part above the grace.
 */
export function computeOvertime(args: {
  coverage: DayCoverage[];
  rateChanges: RateChangeLite[];
  graceMin: number;
  decisionsByDate: Map<string, 'ACCEPTED' | 'REVOKED'>;
}): OvertimeItem[] {
  const items: OvertimeItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.deltaMin <= args.graceMin) continue;
    const rate = rateAt(args.rateChanges, day.lastPunchAt);
    items.push({
      date: day.date,
      overtimeMin: day.deltaMin,
      rate_cent: rate,
      amount_cent: Math.floor((day.deltaMin * rate) / 60),
      decision: args.decisionsByDate.get(day.date) ?? null,
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

export function sumRevokedOvertimeCent(items: OvertimeItem[]): number {
  return items.reduce((s, o) => (o.decision === 'REVOKED' ? s + o.amount_cent : s), 0);
}

/** Load everything needed and compute this user's overtime for a month. */
export async function overtimeForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<OvertimeItem[]> {
  const { start, end } = monthRangeUtc(month);
  const [punches, schedules, overrides, rateChanges, decisions, user] = await Promise.all([
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
    db.overtimeDecision.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, decision: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { overtime_grace_min: true } } },
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

  const decisionsByDate = new Map<string, 'ACCEPTED' | 'REVOKED'>();
  for (const d of decisions) decisionsByDate.set(d.date.toISOString().slice(0, 10), d.decision);

  const graceMin = user?.branch?.overtime_grace_min ?? 15;

  const coverage = computeCoverage({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
  });
  return computeOvertime({
    coverage,
    rateChanges: rateChanges as RateChangeLite[],
    graceMin,
    decisionsByDate,
  });
}

export async function overtimeDeductionForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<number> {
  const items = await overtimeForUser(userId, month, db);
  return sumRevokedOvertimeCent(items);
}
