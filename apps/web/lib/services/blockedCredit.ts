import type { PrismaClient } from '@prisma/client';
import { inBeirut } from 'time';
import { rateAt, monthRangeUtc } from './payout';
import {
  computeCoverage,
  type CreditedTime,
  type DayCoverage,
  type OverrideLite,
  type PunchLite,
  type WorkInterval,
} from './coverage';

/**
 * Paid credit for the time an employee stood at the branch unable to clock in.
 *
 * The shape of the failure: somebody forgets to punch out, so the next
 * check-in is refused with ALREADY_PUNCHED_IN until an admin closes yesterday.
 * Their new day's clock has not started while they wait, so a long enough wait
 * produced a shortfall penalty for a mistake made the day before. The owner
 * ruled the wait is paid - GPS proves they were at the branch and the shop was
 * open, so they were working with no clock running.
 *
 * The day's work therefore starts at the FIRST blocked attempt of that Beirut
 * day, not at the punch that eventually landed.
 *
 * It does NOT pay until the owner accepts it. The cap does not bound the
 * exposure so much as size the credit to fill the day: tap once at 06:00, come
 * back at 15:00, work an hour, and an automatic credit would hand over a full
 * day's gross. So a credited day arrives on the attention queue saying what
 * would be credited and why, and grants nothing until it is accepted.
 */

export interface BlockedAttemptLite {
  at: Date;
}

/** A stored ruling plus the credit it was made against. */
export interface CreditDecisionLite {
  decision: 'ACCEPTED' | 'REVOKED';
  credited_min: number | null;
}

export interface BlockedCreditItem {
  date: string; // YYYY-MM-DD (Beirut)
  blockedAt: Date; // the first refused check-in of that day
  // Where the credited window actually starts: the blocked attempt, unless an
  // earlier day's shift is still being paid past it.
  creditFromAt: Date;
  clockedInAt: Date; // the check-in that finally landed
  waitedMin: number; // the whole wait, before the cap
  creditedMin: number; // what the cap allows, granted or not
  rate_cent: number;
  // What accepting this day is worth. Inside gross only once ACCEPTED; on a
  // pending or revoked day it is what the owner is being asked to approve.
  amount_cent: number;
  // null means pending, and pending grants nothing. Note the inversion against
  // overtime: there, no row means already paid.
  decision: 'ACCEPTED' | 'REVOKED' | null;
}

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

/** The latest checkout at or before `at`, from any day. */
function lastOutAtOrBefore(punches: PunchLite[], at: Date): Date | null {
  let latest: Date | null = null;
  for (const p of punches) {
    if (p.kind !== 'OUT') continue;
    if (p.at > at) continue;
    if (!latest || p.at > latest) latest = p.at;
  }
  return latest;
}

/**
 * A ruling applies to the day as it stood when it was made, and a ruling that
 * no longer names the day's figure reads as pending again - the same mechanic
 * as overtime.
 *
 * The safe default is inverted, and that is the whole point of this direction.
 * An undecided overtime day is paid and an undecided shortfall is docked; an
 * undecided credit grants nothing. So "stale reads as pending" protects the
 * employee for overtime and holds money back here, which is exactly what the
 * owner ruled: no credit moves until he has seen the figure it is for. A
 * correction that grows a credited day cannot quietly grow the payment with
 * it, which is reachable - the cap sizes credit to fill the day, so a deleted
 * punch could turn an approved 30 minutes into an approved eight hours.
 *
 * Nothing is lost by it: the day goes straight back on the queue at its new
 * figure. A null recorded figure predates the column and is stale the same way.
 */
function liveDecision(
  stored: CreditDecisionLite | undefined,
  creditedMin: number,
): 'ACCEPTED' | 'REVOKED' | null {
  if (!stored) return null;
  if (stored.credited_min !== creditedMin) return null;
  return stored.decision;
}

/**
 * One day's credit, from coverage built WITHOUT any credit in it.
 *
 * The cap is the one thing the owner did not rule on: `worked + credited` may
 * not exceed the day's required minutes. Credit exists to erase a shortfall
 * somebody else caused, never to manufacture overtime - without the cap, being
 * blocked becomes worth money and every blocked day arrives on the queue as an
 * overtime notice for waiting. It also makes credit and overtime mutually
 * exclusive by construction: a day with credit has deltaMin <= 0, so it can
 * never raise an overtime item at all.
 */
export function computeBlockedCredits(args: {
  coverage: DayCoverage[];
  punches: PunchLite[];
  attempts: BlockedAttemptLite[];
  rateCentAt: (at: Date) => number;
  decisionsByDate: Map<string, CreditDecisionLite>;
}): BlockedCreditItem[] {
  if (args.attempts.length === 0) return [];

  const firstAttemptByDate = new Map<string, Date>();
  for (const a of args.attempts) {
    const date = inBeirut(a.at).date;
    const current = firstAttemptByDate.get(date);
    if (!current || a.at < current) firstAttemptByDate.set(date, a.at);
  }

  const firstInByDate = new Map<string, Date>();
  for (const p of args.punches) {
    if (p.kind !== 'IN') continue;
    const date = inBeirut(p.at).date;
    const current = firstInByDate.get(date);
    if (!current || p.at < current) firstInByDate.set(date, p.at);
  }

  const coverageByDate = new Map(args.coverage.map((d) => [d.date, d]));

  const items: BlockedCreditItem[] = [];
  for (const [date, blockedAt] of firstAttemptByDate) {
    const day = coverageByDate.get(date);
    if (!day) continue; // blocked, never got in that day - no day's work to start
    const clockedInAt = firstInByDate.get(date);
    if (!clockedInAt) continue;
    // The block has to come before the day's first check-in. If it does not,
    // the session in the way started on this same day and its minutes are
    // already counted from their own check-in - crediting the wait as well
    // would pay the same stretch twice.
    if (clockedInAt <= blockedAt) continue;

    // Do not credit minutes somebody is already being paid for. An overnight
    // shift belongs to the day it STARTED, so a 21:00-07:00 Sunday shift puts
    // paid minutes inside Monday morning - and a Monday 06:00 attempt followed
    // by a Monday 09:00 check-in would otherwise credit 06:00-07:00 a second
    // time. The last checkout at or before the successful punch is where the
    // uncredited gap really begins, whichever day that checkout is attributed
    // to.
    const coveredUntil = lastOutAtOrBefore(args.punches, clockedInAt);
    const creditFromAt =
      coveredUntil && coveredUntil > blockedAt ? coveredUntil : blockedAt;
    if (creditFromAt >= clockedInAt) continue;

    const waitedMin = Math.max(0, Math.floor((clockedInAt.getTime() - creditFromAt.getTime()) / 60_000));
    const headroomMin = day.requiredMin - day.workedMin;
    const creditedMin = Math.max(0, Math.min(waitedMin, headroomMin));
    if (creditedMin === 0) continue;

    // The rate in force when the credited stretch ENDED, which is where
    // payout.ts resolves the rate for a worked interval too (its closing
    // punch). Same instant rule, so a raise landing mid-morning prices the
    // credit exactly as it prices the shift it runs into.
    const rate = args.rateCentAt(clockedInAt);
    items.push({
      date,
      blockedAt,
      creditFromAt,
      clockedInAt,
      waitedMin,
      creditedMin,
      rate_cent: rate,
      amount_cent: Math.floor((creditedMin * rate) / 60),
      decision: liveDecision(args.decisionsByDate.get(date), creditedMin),
    });
  }

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

/**
 * The priced minutes a credit actually grants: ACCEPTED days and no others.
 *
 * Pending and revoked both grant nothing, and neither is a clawback - the
 * credit was never in gross to begin with. That is why nothing anywhere needs
 * a deduction line for a revoked credit, and why an unreviewed day reads
 * exactly as if the employee had never been blocked.
 *
 * This is the single gate. Everything that has to agree about a day - the
 * coverage that decides the shortfall, the intervals that reach pairHours -
 * is built from this one list, so a day cannot be credited in one and not the
 * other whatever its decision is.
 */
export function grantedCredit(items: BlockedCreditItem[]): CreditedTime[] {
  return items
    .filter((i) => i.decision === 'ACCEPTED')
    .map((i) => ({ date: i.date, minutes: i.creditedMin, rateCent: i.rate_cent }));
}

/** The same figures as WorkIntervals, for the payout side of the money path. */
export function grantedIntervals(items: BlockedCreditItem[]): WorkInterval[] {
  return grantedCredit(items).map((c) => ({ minutes: c.minutes, rateCent: c.rateCent }));
}

/**
 * A user's coverage with their blocked-time credit folded in, plus the credit
 * items behind it.
 *
 * Two passes, and it has to be two: the cap needs the day's required and
 * worked minutes, which only coverage knows, and coverage needs the credit.
 * Pass one is punches alone; pass two adds the credit that pass one sized. It
 * lives here, in one function, because every reader of a day - penalties,
 * overtime, the payslip, the attention queue - has to see the same day, and
 * five copies of a two-pass build is five chances for one of them to drift.
 */
export function coverageWithBlockedCredit(args: {
  punches: PunchLite[];
  shiftMinByWeekday: Map<number, number>;
  overridesByDate: Map<string, OverrideLite>;
  rateCentAt: (at: Date) => number;
  attempts: BlockedAttemptLite[];
  decisionsByDate: Map<string, CreditDecisionLite>;
}): { coverage: DayCoverage[]; credits: BlockedCreditItem[] } {
  const base = {
    punches: args.punches,
    shiftMinByWeekday: args.shiftMinByWeekday,
    overridesByDate: args.overridesByDate,
    rateCentAt: args.rateCentAt,
  };
  const uncredited = computeCoverage(base);
  const credits = computeBlockedCredits({
    coverage: uncredited,
    punches: args.punches,
    attempts: args.attempts,
    rateCentAt: args.rateCentAt,
    decisionsByDate: args.decisionsByDate,
  });
  if (credits.length === 0) return { coverage: uncredited, credits };
  return { coverage: computeCoverage({ ...base, credited: grantedCredit(credits) }), credits };
}

export interface BlockedCreditInputs {
  attemptsByUser: Map<string, BlockedAttemptLite[]>;
  decisionsByUser: Map<string, Map<string, CreditDecisionLite>>;
}

/**
 * The two extra tables every reader of a day now needs, loaded once for a set
 * of users. Kept here rather than repeated in penalty.ts and overtime.ts so
 * adding a reader is one call, not two queries and two groupings to get right.
 */
export async function loadBlockedCreditInputs(
  userIds: string[],
  start: Date,
  end: Date,
  db: PrismaClient,
): Promise<BlockedCreditInputs> {
  const attemptsByUser = new Map<string, BlockedAttemptLite[]>();
  const decisionsByUser = new Map<string, Map<string, CreditDecisionLite>>();
  if (userIds.length === 0) return { attemptsByUser, decisionsByUser };

  const [attempts, decisions] = await Promise.all([
    db.blockedPunchAttempt.findMany({
      where: { user_id: { in: userIds }, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { user_id: true, at: true },
    }),
    db.blockedCreditDecision.findMany({
      where: { user_id: { in: userIds }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, decision: true, credited_min: true },
    }),
  ]);

  for (const a of attempts) {
    const list = attemptsByUser.get(a.user_id);
    if (list) list.push({ at: a.at });
    else attemptsByUser.set(a.user_id, [{ at: a.at }]);
  }
  for (const d of decisions) {
    const key = d.date.toISOString().slice(0, 10);
    const lite: CreditDecisionLite = { decision: d.decision, credited_min: d.credited_min };
    const forUser = decisionsByUser.get(d.user_id);
    if (forUser) forUser.set(key, lite);
    else decisionsByUser.set(d.user_id, new Map([[key, lite]]));
  }

  return { attemptsByUser, decisionsByUser };
}

/** Load everything needed and compute this user's blocked-time credit for a month. */
export async function blockedCreditForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<BlockedCreditItem[]> {
  const { start, end } = monthRangeUtc(month);
  const [punches, schedules, overrides, rateChanges, blocked] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: start, lt: end } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    db.schedule.findMany({ where: { user_id: userId }, select: { weekday: true, shift_min: true } }),
    db.scheduleOverride.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, kind: true, shift_min: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { rate_cent: true, effective_from: true },
    }),
    loadBlockedCreditInputs([userId], start, end, db),
  ]);

  const shiftMinByWeekday = new Map<number, number>();
  for (const s of schedules) shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);

  const overridesByDate = new Map<string, OverrideLite>();
  for (const o of overrides) {
    if (o.kind !== 'DAY_OFF' && o.kind !== 'HOURS_CHANGE') continue;
    overridesByDate.set(o.date.toISOString().slice(0, 10), { kind: o.kind, shift_min: o.shift_min });
  }

  return coverageWithBlockedCredit({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
    rateCentAt: (at) => rateAt(rateChanges as RateChangeLite[], at),
    attempts: blocked.attemptsByUser.get(userId) ?? [],
    decisionsByDate: blocked.decisionsByUser.get(userId) ?? new Map(),
  }).credits;
}

/**
 * The day's credited minutes as they stand right now, for stamping onto a
 * ruling. Read through blockedCreditForUser so the figure a decision is
 * stamped with cannot disagree with the figure every reader sees. A day with
 * no credit is zero, which never matches a real notice and so can never
 * authorise withholding anything.
 */
export async function creditedMinForDay(
  userId: string,
  date: string,
  db: PrismaClient,
): Promise<number> {
  const items = await blockedCreditForUser(userId, date.slice(0, 7), db);
  return items.find((i) => i.date === date)?.creditedMin ?? 0;
}

/**
 * Granted credit minutes per user per Beirut date, for the screens that count
 * "hours on this day" rather than money.
 *
 * They have to see it or they contradict the payslip on the same screen: the
 * month figure comes through payoutForUser and already includes accepted
 * credit, while the day figure is built from punches alone.
 */
export async function grantedCreditMinutesByDate(
  userIds: string[],
  month: string,
  db: PrismaClient,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (userIds.length === 0) return out;
  const notices = await allBlockedCredits(userIds, month, db);
  for (const [userId, items] of notices) {
    const byDate = new Map<string, number>();
    for (const c of items) {
      if (c.decision !== 'ACCEPTED') continue;
      byDate.set(c.date, (byDate.get(c.date) ?? 0) + c.creditedMin);
    }
    if (byDate.size > 0) out.set(userId, byDate);
  }
  return out;
}

export interface BlockedCreditNotice extends BlockedCreditItem {
  user_id: string;
  username: string;
}

// Credited days the admin has not ruled on, for the attention queue. Batch
// loaded across all users at once, mirroring pendingPenaltyNotices and
// pendingOvertimeNotices - the dashboard polls every 10s. A day drops off once
// it has a live decision either way.
export async function pendingBlockedCreditNotices(
  users: Array<{ id: string; username: string }>,
  month: string,
  db: PrismaClient,
  opts: { since: string },
): Promise<BlockedCreditNotice[]> {
  if (users.length === 0) return [];
  const byUser = await allBlockedCredits(users.map((u) => u.id), month, db);

  const notices: BlockedCreditNotice[] = [];
  for (const u of users) {
    for (const c of byUser.get(u.id) ?? []) {
      // Only undecided days. Nothing has been paid on them, so this is an
      // approval queue rather than a review one.
      if (c.decision !== null) continue;
      if (c.date < opts.since) continue;
      notices.push({ ...c, user_id: u.id, username: u.username });
    }
  }

  notices.sort((a, b) => (a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));
  return notices;
}

/** Every user's blocked-time credit for a month, decided or not. Batch loaded. */
async function allBlockedCredits(
  ids: string[],
  month: string,
  db: PrismaClient,
): Promise<Map<string, BlockedCreditItem[]>> {
  const out = new Map<string, BlockedCreditItem[]>();
  if (ids.length === 0) return out;
  const { start, end } = monthRangeUtc(month);

  const [punches, schedules, overrides, rateChanges, blocked] = await Promise.all([
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

  for (const id of ids) {
    const attempts = blocked.attemptsByUser.get(id);
    if (!attempts || attempts.length === 0) continue;

    const shiftMinByWeekday = new Map<number, number>();
    for (const s of schedulesBy.get(id) ?? []) shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);

    const overridesByDate = new Map<string, OverrideLite>();
    for (const o of overridesBy.get(id) ?? []) {
      if (o.kind !== 'DAY_OFF' && o.kind !== 'HOURS_CHANGE') continue;
      overridesByDate.set(o.date.toISOString().slice(0, 10), { kind: o.kind, shift_min: o.shift_min });
    }

    const userRates = (ratesBy.get(id) ?? []) as RateChangeLite[];
    const { credits } = coverageWithBlockedCredit({
      punches: (punchesBy.get(id) ?? []) as PunchLite[],
      shiftMinByWeekday,
      overridesByDate,
      rateCentAt: (at) => rateAt(userRates, at),
      attempts,
      decisionsByDate: blocked.decisionsByUser.get(id) ?? new Map(),
    });
    if (credits.length > 0) out.set(id, credits);
  }

  return out;
}
