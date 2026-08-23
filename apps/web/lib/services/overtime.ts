import type { PrismaClient } from '@prisma/client';
import { rateAt, monthRangeUtc } from './payout';
import {
  centsForLastMinutes,
  type DayCoverage,
  type OverrideLite,
  type PunchLite,
} from './coverage';
import { coverageWithBlockedCredit, loadBlockedCreditInputs } from './blockedCredit';

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

/** A stored ruling plus the overtime it was made against. */
export interface DecisionLite {
  decision: 'ACCEPTED' | 'REVOKED';
  overtime_min: number | null;
}

/**
 * A ruling applies to the day as it stood when it was made. One row per
 * calendar day, but the day's overtime keeps moving as punches land, so a
 * ruling made against 120 minutes must not silently expand to cover 300. When
 * the figures disagree the ruling is stale and the day reads as pending again:
 * back on the review queue at the full new amount, and nothing deducted until
 * the owner rules on that amount. A null recorded figure predates the column
 * and is stale for the same reason - erring towards paying the employee.
 */
function liveDecision(stored: DecisionLite | undefined, overtimeMin: number): 'ACCEPTED' | 'REVOKED' | null {
  if (!stored) return null;
  if (stored.overtime_min !== overtimeMin) return null;
  return stored.decision;
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
  decisionsByDate: Map<string, DecisionLite>;
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
      // What the excess minutes were actually paid, not deltaMin at one rate.
      // The excess is the part of the day worked after the required minutes
      // were covered, so it is the LAST deltaMin minutes - priced per interval
      // like payroll pays them. deltaMin * rateAt(lastPunch) prices the whole
      // overrun at whatever rate happened to be in force at the closing punch:
      // after a mid-shift raise that takes back more than the excess earned,
      // and on a day requiring nothing it can exceed the day's entire gross.
      // Revoking has to leave the employee their required hours' pay, and this
      // is the only expression that does.
      amount_cent: centsForLastMinutes(day.intervals, day.deltaMin),
      decision: liveDecision(args.decisionsByDate.get(day.date), day.deltaMin),
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
  const [punches, schedules, overrides, rateChanges, decisions, user, blocked] = await Promise.all([
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
      select: { date: true, decision: true, overtime_min: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { shift_grace_min: true } } },
    }),
    loadBlockedCreditInputs([userId], start, end, db),
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

  const decisionsByDate = new Map<string, DecisionLite>();
  for (const d of decisions) {
    decisionsByDate.set(d.date.toISOString().slice(0, 10), {
      decision: d.decision,
      overtime_min: d.overtime_min,
    });
  }

  const graceMin = user?.branch?.shift_grace_min ?? 15;

  // The same day every other reader sees. Credit is capped so worked +
  // credited never exceeds the day's required minutes, so it can never raise
  // an overtime notice - but reading a different coverage here would leave
  // that as an argument rather than a fact.
  const { coverage } = coverageWithBlockedCredit({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
    rateCentAt: (at) => rateAt(rateChanges as RateChangeLite[], at),
    attempts: blocked.attemptsByUser.get(userId) ?? [],
    decisionsByDate: blocked.decisionsByUser.get(userId) ?? new Map(),
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

/**
 * The day's overtime minutes as they stand right now, for stamping onto a
 * decision. Computed here rather than taken from the caller: it is the figure
 * that decides whether money moves, so the client must not get a say in it.
 * A day with no overtime item (inside the grace, or still open) is zero, which
 * never matches a real notice and so can never authorise a deduction.
 */
export async function overtimeMinForDay(
  userId: string,
  date: string,
  db: PrismaClient,
): Promise<number> {
  const items = await overtimeForUser(userId, date.slice(0, 7), db);
  return items.find((i) => i.date === date)?.overtimeMin ?? 0;
}

export interface OvertimeNotice extends OvertimeItem {
  user_id: string;
  username: string;
}

// Overtime the admin has not dealt with yet, for the attention queue. Batch-loaded
// across all users at once, mirroring pendingPenaltyNotices - the dashboard polls
// every 10s, and a per-user round trip would be dozens of queries each time.
// A day drops off this list once it has a decision (accepted or revoked).
export async function pendingOvertimeNotices(
  users: Array<{ id: string; username: string }>,
  month: string,
  db: PrismaClient,
  opts: { since: string },
): Promise<OvertimeNotice[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);
  const { start, end } = monthRangeUtc(month);

  const [punches, schedules, overrides, rateChanges, decisions, userBranches, blocked] = await Promise.all([
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
    db.overtimeDecision.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, decision: true, overtime_min: true },
    }),
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, branch: { select: { shift_grace_min: true } } },
    }),
    loadBlockedCreditInputs(ids, start, end, db),
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

  const decisionsByUser = new Map<string, Map<string, DecisionLite>>();
  for (const d of decisions) {
    const dateKey = d.date.toISOString().slice(0, 10);
    const lite: DecisionLite = { decision: d.decision, overtime_min: d.overtime_min };
    const forUser = decisionsByUser.get(d.user_id);
    if (forUser) forUser.set(dateKey, lite);
    else decisionsByUser.set(d.user_id, new Map([[dateKey, lite]]));
  }

  const graceByUser = new Map<string, number>();
  for (const u of userBranches) graceByUser.set(u.id, u.branch?.shift_grace_min ?? 15);

  const notices: OvertimeNotice[] = [];
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

    const userRates = (ratesBy.get(u.id) ?? []) as RateChangeLite[];
    const { coverage } = coverageWithBlockedCredit({
      punches: (punchesBy.get(u.id) ?? []) as PunchLite[],
      shiftMinByWeekday,
      overridesByDate,
      rateCentAt: (at) => rateAt(userRates, at),
      attempts: blocked.attemptsByUser.get(u.id) ?? [],
      decisionsByDate: blocked.decisionsByUser.get(u.id) ?? new Map(),
    });
    const items = computeOvertime({
      coverage,
      rateChanges: userRates,
      graceMin: graceByUser.get(u.id) ?? 15,
      decisionsByDate: decisionsByUser.get(u.id) ?? new Map(),
    });

    for (const o of items) {
      if (o.decision !== null) continue;
      if (o.date < opts.since) continue;
      notices.push({ ...o, user_id: u.id, username: u.username });
    }
  }

  notices.sort((a, b) => (a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));
  return notices;
}
