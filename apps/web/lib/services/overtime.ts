import type { PrismaClient } from '@prisma/client';
import { todayInBeirut, workingDayHistoryFrom } from 'time';
import { hourlyRateAt, monthRangeUtc, PAIR_LOOKAROUND_MS } from './payout';
import {
  centsForLastMinutes,
  type DayCoverage,
  type OverrideLite,
  type PunchLite,
  dayStartHourFor,
  weeklyHoursFrom,
} from './coverage';
import { coverageWithBlockedCredit, loadBlockedCreditInputs } from './blockedCredit';

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

export interface OvertimeItem {
  date: string; // YYYY-MM-DD (Beirut)
  overtimeMin: number;
  // The overtime rate that day, or the hourly rate when none is set.
  rate_cent: number;
  // What the overtime minutes are paid - at the overtime rate when one is set.
  // Inside gross pay: pairHours pays every minute at the hourly rate, and the
  // premium below is added on top. Revoke takes back exactly this.
  amount_cent: number;
  // amount_cent minus what the same minutes earn at the hourly rate. Zero with
  // no overtime rate, or on a day before OVERTIME_RATE_FROM.
  premium_cent: number;
  decision: 'ACCEPTED' | 'REVOKED' | null; // null means pending, and pending is paid
}

/**
 * The first working day overtime is paid at a person's own overtime rate
 * (the owner's rule, 2026-10-01). Every day before keeps the hourly rate, so no
 * month already paid can move.
 */
export const OVERTIME_RATE_FROM = '2026-10-01';

export interface OvertimeRateRow {
  rate_cent: number | null;
  effective_from: Date;
}

/**
 * The working day a newly saved overtime rate takes effect from.
 *
 * A person's FIRST rate covers the whole month it is set in - the owner chose
 * "from 1 October", and the 1st of the current month is never a closed month.
 * Every later change applies from today, like the hourly rate. Never before
 * OVERTIME_RATE_FROM.
 */
export function overtimeRateEffectiveDate(isFirstRate: boolean, now: Date = new Date()): string {
  const today = todayInBeirut(now);
  const date = isFirstRate ? `${today.slice(0, 7)}-01` : today;
  return date < OVERTIME_RATE_FROM ? OVERTIME_RATE_FROM : date;
}

/**
 * Saves a person's overtime rate change, if it is one: one row per working day,
 * so a second change the same day replaces the first. Returns whether it wrote.
 */
export async function recordOvertimeRate(
  tx: Pick<PrismaClient, 'overtimeRateChange'>,
  userId: string,
  rateCent: number | null,
  previous: number | null,
): Promise<boolean> {
  if (rateCent === previous) return false;
  const isFirstRate = (await tx.overtimeRateChange.count({ where: { user_id: userId } })) === 0;
  // A first "no overtime rate" is what everyone already has: nothing to record.
  if (isFirstRate && rateCent === null) return false;
  const effective_from = new Date(`${overtimeRateEffectiveDate(isFirstRate)}T00:00:00.000Z`);
  await tx.overtimeRateChange.upsert({
    where: { user_id_effective_from: { user_id: userId, effective_from } },
    create: { user_id: userId, rate_cent: rateCent, effective_from },
    update: { rate_cent: rateCent },
  });
  return true;
}

/**
 * The overtime rate in force on a working day, or null for "the hourly rate".
 *
 * Dated by working day rather than instant because overtime is judged per day:
 * a day has one overtime rate, and a row dated today cannot reach back into a
 * night shift that started yesterday - or into a closed month.
 */
export function overtimeRateOn(rows: OvertimeRateRow[], date: string): number | null {
  if (date < OVERTIME_RATE_FROM) return null;
  const day = new Date(`${date}T00:00:00.000Z`).getTime();
  let best: OvertimeRateRow | undefined;
  for (const r of rows) {
    if (r.effective_from.getTime() > day) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best?.rate_cent ?? null;
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
  /** The person's overtime rate on a working day (overtimeRateOn); omitted, the hourly rate. */
  overtimeRateOn?: (date: string) => number | null;
}): OvertimeItem[] {
  const items: OvertimeItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.deltaMin <= args.graceMin) continue;
    const rate = hourlyRateAt(args.rateChanges, day.lastPunchAt);
    // What payroll already paid the overtime minutes, at the hourly rate.
    const hourlyCent = centsForLastMinutes(day.intervals, day.deltaMin);
    const overtimeRate = args.overtimeRateOn?.(day.date) ?? null;
    // The same minutes repriced at the overtime rate, floored per interval the
    // way the hourly figure is, so the premium is exactly the difference.
    const amount =
      overtimeRate === null
        ? hourlyCent
        : centsForLastMinutes(
            day.intervals.map((iv) => ({ minutes: iv.minutes, rateCent: overtimeRate })),
            day.deltaMin,
          );
    items.push({
      date: day.date,
      overtimeMin: day.deltaMin,
      rate_cent: overtimeRate ?? rate,
      // What the excess minutes were actually paid, not deltaMin at one rate.
      // The excess is the part of the day worked after the required minutes
      // were covered, so it is the LAST deltaMin minutes - priced per interval
      // like payroll pays them. deltaMin * rateAt(lastPunch) prices the whole
      // overrun at whatever rate happened to be in force at the closing punch:
      // after a mid-shift raise that takes back more than the excess earned,
      // and on a day requiring nothing it can exceed the day's entire gross.
      // Revoking has to leave the employee their required hours' pay, and this
      // is the only expression that does.
      amount_cent: amount,
      premium_cent: amount - hourlyCent,
      decision: liveDecision(args.decisionsByDate.get(day.date), day.deltaMin),
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

export function sumRevokedOvertimeCent(items: OvertimeItem[]): number {
  return items.reduce((s, o) => (o.decision === 'REVOKED' ? s + o.amount_cent : s), 0);
}

/**
 * The overtime premium a month adds to gross - every overtime day, revoked ones
 * included, because a revoked day's deduction (sumRevokedOvertimeCent) takes
 * back the premium along with the hourly part.
 */
export function sumOvertimePremiumCent(items: OvertimeItem[]): number {
  return items.reduce((s, o) => s + o.premium_cent, 0);
}

/** Load everything needed and compute this user's overtime for a month. */
export async function overtimeForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<OvertimeItem[]> {
  const { start, end } = monthRangeUtc(month);
  // Punches are read two days either side of the month and each DAY is then
  // filtered back to it. A shift that starts on the 30th and ends on the 1st has
  // its checkout outside the month window, so the plain window handed coverage
  // an arrival with no departure - an unclosed day, which is never judged. The
  // last night of every month therefore raised no overtime and no penalty, for
  // every overnight worker, in either month. Same seam payout.ts pairs across.
  const punchFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const punchTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const [punches, schedules, overrides, rateChanges, decisions, user, blocked, overtimeRates] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: workingDayHistoryFrom(punchFrom), lt: punchTo } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: userId },
      select: { weekday: true, shift_min: true, effective_from: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, kind: true, shift_min: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: punchTo } },
      orderBy: { effective_from: 'asc' },
      select: { rate_cent: true, effective_from: true },
    }),
    db.overtimeDecision.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, decision: true, overtime_min: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { day_start_hour: true, branch: { select: { shift_grace_min: true } } },
    }),
    loadBlockedCreditInputs([userId], punchFrom, punchTo, db),
    db.overtimeRateChange.findMany({
      where: { user_id: userId },
      select: { rate_cent: true, effective_from: true },
    }),
  ]);

  // The hours in force on each day judged - not today's - so an edit never
  // re-judges a day already paid.
  const shiftMinByWeekday = weeklyHoursFrom(schedules);

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
    rateCentAt: (at) => hourlyRateAt(rateChanges as RateChangeLite[], at),
    attempts: blocked.attemptsByUser.get(userId) ?? [],
    decisionsByDate: blocked.decisionsByUser.get(userId) ?? new Map(),
    dayStartHour: dayStartHourFor(user),
  });
  // Back to the month asked for. The window above deliberately reaches into the
  // neighbouring months to close the shifts that straddle a boundary; only the
  // days that BELONG to this month may be returned, or September's query would
  // report August's last night as well.
  return computeOvertime({
    coverage,
    rateChanges: rateChanges as RateChangeLite[],
    graceMin,
    decisionsByDate,
    overtimeRateOn: (date) => overtimeRateOn(overtimeRates, date),
  }).filter((o) => o.date.slice(0, 7) === month);
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
  // Punches are read two days either side of the month and each DAY is then
  // filtered back to it. A shift that starts on the 30th and ends on the 1st has
  // its checkout outside the month window, so the plain window handed coverage
  // an arrival with no departure - an unclosed day, which is never judged. The
  // last night of every month therefore raised no overtime and no penalty, for
  // every overnight worker, in either month. Same seam payout.ts pairs across.
  const punchFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const punchTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);

  const [punches, schedules, overrides, rateChanges, decisions, userBranches, blocked, overtimeRates] = await Promise.all([
    db.punch.findMany({
      where: { user_id: { in: ids }, at: { gte: workingDayHistoryFrom(punchFrom), lt: punchTo } },
      orderBy: { at: 'asc' },
      select: { user_id: true, kind: true, at: true },
    }),
    db.schedule.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, weekday: true, shift_min: true, effective_from: true },
    }),
    db.scheduleOverride.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true, shift_min: true },
    }),
    db.rateChange.findMany({
      where: { user_id: { in: ids }, effective_from: { lt: punchTo } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    db.overtimeDecision.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, decision: true, overtime_min: true },
    }),
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, day_start_hour: true, branch: { select: { shift_grace_min: true } } },
    }),
    loadBlockedCreditInputs(ids, punchFrom, punchTo, db),
    db.overtimeRateChange.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, rate_cent: true, effective_from: true },
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
  const overtimeRatesBy = by(overtimeRates);

  const decisionsByUser = new Map<string, Map<string, DecisionLite>>();
  for (const d of decisions) {
    const dateKey = d.date.toISOString().slice(0, 10);
    const lite: DecisionLite = { decision: d.decision, overtime_min: d.overtime_min };
    const forUser = decisionsByUser.get(d.user_id);
    if (forUser) forUser.set(dateKey, lite);
    else decisionsByUser.set(d.user_id, new Map([[dateKey, lite]]));
  }

  const graceByUser = new Map<string, number>();
  const dayStartByUser = new Map<string, number>();
  for (const u of userBranches) {
    graceByUser.set(u.id, u.branch?.shift_grace_min ?? 15);
    dayStartByUser.set(u.id, dayStartHourFor(u));
  }

  const notices: OvertimeNotice[] = [];
  for (const u of users) {
    const shiftMinByWeekday = weeklyHoursFrom(schedulesBy.get(u.id) ?? []);
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
      rateCentAt: (at) => hourlyRateAt(userRates, at),
      attempts: blocked.attemptsByUser.get(u.id) ?? [],
      decisionsByDate: blocked.decisionsByUser.get(u.id) ?? new Map(),
      dayStartHour: dayStartByUser.get(u.id) ?? 0,
    });
    const items = computeOvertime({
      coverage,
      rateChanges: userRates,
      graceMin: graceByUser.get(u.id) ?? 15,
      decisionsByDate: decisionsByUser.get(u.id) ?? new Map(),
      overtimeRateOn: (date) => overtimeRateOn(overtimeRatesBy.get(u.id) ?? [], date),
    }).filter((o) => o.date.slice(0, 7) === month);

    for (const o of items) {
      if (o.decision !== null) continue;
      if (o.date < opts.since) continue;
      notices.push({ ...o, user_id: u.id, username: u.username });
    }
  }

  notices.sort((a, b) => (a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));
  return notices;
}
