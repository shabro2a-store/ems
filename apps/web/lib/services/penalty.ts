import type { PrismaClient } from '@prisma/client';
import { rateAt, monthRangeUtc } from './payout';
import {
  computeCoverage,
  currentShiftDayMinutes,
  type DayCoverage,
  type OverrideLite,
  type PunchLite,
} from './coverage';

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
  rate_cent: number; // the rate in force at the day's last punch, for reference
  // floor(penaltyMin * rate_cent / 60), clamped to what the day actually earned
  amount_cent: number;
  waived: boolean; // money: a waiver row exists, so nothing is docked for this day
  waiverStale: boolean; // review: that waiver was given against a different figure
}

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

/** A stored ruling on one day's penalty plus the figure it was made against. */
export interface PenaltyDecisionLite {
  penalty_min: number | null;
}

/**
 * Whether a stored ruling still names the figure the day currently has.
 *
 * A ruling was made on the day as it stood at the time, and the penalty moves
 * whenever a punch is corrected - which this owner does by hand routinely. When
 * the figures disagree the ruling no longer describes the day, so the day is
 * unreviewed and belongs back on the attention queue at its new amount. A null
 * recorded figure predates the column and is unreviewed for the same reason.
 *
 * This decides REVIEW only, never money. Whether a penalty is docked is decided
 * by the presence of a waiver row, because the two possible mistakes are not
 * equal: keeping a stale forgiveness leaves the employee holding money the owner
 * may have wanted back, while dropping it takes money the owner had already
 * decided to give them. The owner settled that tension for overtime - a stale
 * ruling moves nothing until he rules again - and the same answer applies here.
 * It has to be spelled out because the safe default is inverted between the two:
 * an undecided overtime day is paid, an undecided shortfall is docked, so
 * "ignore the stale row" protects the employee there and robs them here.
 */
function ruledOn(stored: PenaltyDecisionLite | undefined, penaltyMin: number): boolean {
  if (!stored) return false;
  return stored.penalty_min === penaltyMin;
}

/**
 * The shift-day the employee is on right now, which is the day a shortfall must
 * not be judged on yet. Delegated to currentShiftDayMinutes so there is one
 * definition of "the day they are currently working": the Beirut day of their
 * open arrival, or today when nothing is open.
 *
 * Callers pass the punches they already loaded. A month window always contains
 * an open arrival belonging to that month, which is the only one that can name
 * a day inside that month's coverage.
 */
export function currentShiftDate(punches: PunchLite[], now: Date): string {
  return currentShiftDayMinutes({ punches, now }).date;
}

/**
 * Shortfall penalties from a day's coverage.
 *
 * Two kinds of day are not judged. An unclosed day, because its hours are
 * unknowable until the missing punch is corrected. And the current shift-day,
 * because it is not over: staff work split shifts, so punching out after the
 * morning session used to raise a full shortfall against the whole day's hours
 * the instant it closed, only for it to vanish when they came back in the
 * evening. Both conditions are needed - a split-shift worker between sessions
 * has no open punch, so `closed` is true and only the shift-day check saves
 * them; someone still clocked in on a past day is caught by `closed` alone.
 */
export function shortfallPenalties(args: {
  coverage: DayCoverage[];
  rateChanges: RateChangeLite[];
  graceMin: number;
  currentShiftDate: string;
  waivers: Map<string, PenaltyDecisionLite>; // keyed `${date}|SHORTFALL`
}): PenaltyItem[] {
  const items: PenaltyItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.date === args.currentShiftDate) continue;
    if (day.deltaMin >= 0) continue;
    const shortfallMin = -day.deltaMin;
    const penaltyMin = penaltyMinutes(shortfallMin, day.workedMin, args.graceMin);
    if (penaltyMin === 0) continue;
    const rate = rateAt(args.rateChanges, day.lastPunchAt);
    const waiver = args.waivers.get(`${day.date}|SHORTFALL`);
    // The minute ceiling gets the intent right but cannot get the money right
    // on its own: it prices the whole day at one rate, while payroll prices
    // each interval at the rate in force when it closed. A RateChange saved
    // mid-shift makes the two disagree, and the penalty can then exceed the
    // day's pay and start taking the next day's - the exact thing the owner
    // called unethical. Sum-of-floors also runs below floor-of-sum by up to a
    // cent per interval. Clamping to the day's own gross closes both, and is
    // what makes "the worst day is zero pay" true rather than nearly true.
    const amountCent = Math.min(Math.floor((penaltyMin * rate) / 60), day.grossCent);
    // A penalty that takes nothing is not a penalty. Accept and Revoke on a
    // $0.00 row are both no-ops, so surfacing one would park an item on the
    // review queue that no click can resolve into anything.
    //
    // It is reachable, and not only by rounding: a day whose rate resolves to
    // zero grosses zero, and the clamp then takes the penalty to zero with it.
    // That happens when a punch is backdated to before the employee's first
    // RateChange - which this owner does by hand. Note what that day really
    // means: the employee is being paid nothing for it. That is a rate-history
    // problem, much larger than the penalty, and the penalty queue is the wrong
    // place to report it - see the zero-priced day in SYSTEM_MAP's known issues.
    if (amountCent === 0) continue;
    items.push({
      date: day.date,
      kind: 'SHORTFALL',
      shortfallMin,
      penaltyMin,
      rate_cent: rate,
      amount_cent: amountCent,
      // The row itself stops the money, whatever figure it names - the owner
      // decided this employee keeps this day's pay, and a correction he made
      // afterwards must not quietly reverse that. The recorded figure only
      // decides whether he is asked to look at the day again.
      waived: waiver !== undefined,
      waiverStale: waiver !== undefined && !ruledOn(waiver, penaltyMin),
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
  opts: { now?: Date } = {},
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
      select: { date: true, kind: true, penalty_min: true },
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

  const waiversByKey = new Map<string, PenaltyDecisionLite>();
  for (const w of waivers) {
    waiversByKey.set(`${w.date.toISOString().slice(0, 10)}|${w.kind}`, { penalty_min: w.penalty_min });
  }

  const coverage = computeCoverage({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
    rateCentAt: (at) => rateAt(rateChanges as RateChangeLite[], at),
  });
  return shortfallPenalties({
    coverage,
    rateChanges: rateChanges as RateChangeLite[],
    graceMin: user?.branch?.shift_grace_min ?? DEFAULT_GRACE_MIN,
    currentShiftDate: currentShiftDate(punches as PunchLite[], opts.now ?? new Date()),
    waivers: waiversByKey,
  });
}

/**
 * The day's docked minutes as they stand right now, for stamping onto a ruling.
 * Read through penaltiesForUser rather than recomputed here, so the figure a
 * decision is stamped with cannot disagree with the figure every reader sees.
 * A day with no penalty (inside the grace, still open, or the current
 * shift-day) is zero, which never matches a real notice.
 */
export async function penaltyMinForDay(
  userId: string,
  date: string,
  kind: PenaltyKind,
  db: PrismaClient,
): Promise<number> {
  const items = await penaltiesForUser(userId, date.slice(0, 7), db);
  return items.find((i) => i.date === date && i.kind === kind)?.penaltyMin ?? 0;
}

// A waived day contributes nothing, stale waiver included: `waived` is the
// presence of the owner's removal, not its currency. `waiverStale` is what puts
// the day back in front of him, and until he rules again the employee keeps the
// money he already gave them.
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
  const now = opts.now ?? new Date();
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
      select: { user_id: true, date: true, kind: true, penalty_min: true },
    }),
    db.penaltyAck.findMany({
      where: { user_id: { in: ids }, date: { gte: start, lt: end } },
      select: { user_id: true, date: true, kind: true, penalty_min: true },
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

  const acksByKey = new Map<string, PenaltyDecisionLite>();
  for (const a of acks) {
    acksByKey.set(`${a.user_id}|${a.date.toISOString().slice(0, 10)}|${a.kind}`, { penalty_min: a.penalty_min });
  }

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
    const waiversByKey = new Map<string, PenaltyDecisionLite>();
    for (const w of waiversBy.get(u.id) ?? []) {
      waiversByKey.set(`${w.date.toISOString().slice(0, 10)}|${w.kind}`, { penalty_min: w.penalty_min });
    }

    const userPunches = (punchesBy.get(u.id) ?? []) as PunchLite[];
    const userRates = (ratesBy.get(u.id) ?? []) as RateChangeLite[];
    const coverage = computeCoverage({
      punches: userPunches,
      shiftMinByWeekday,
      overridesByDate,
      rateCentAt: (at) => rateAt(userRates, at),
    });
    const items = shortfallPenalties({
      coverage,
      rateChanges: userRates,
      graceMin: graceByUser.get(u.id) ?? DEFAULT_GRACE_MIN,
      currentShiftDate: currentShiftDate(userPunches, now),
      waivers: waiversByKey,
    });

    for (const p of items) {
      if (p.date < opts.since) continue;
      if (p.waived) {
        // Forgiven either way. While the waiver still names this figure the
        // owner has seen exactly this penalty and there is nothing to show him;
        // once a correction moves the day, the removal he granted covers an
        // amount that no longer exists, so he is asked about the new one - with
        // the money left where he put it in the meantime.
        if (!p.waiverStale) continue;
      } else if (ruledOn(acksByKey.get(`${u.id}|${p.date}|${p.kind}`), p.penaltyMin)) {
        continue;
      }
      notices.push({ ...p, user_id: u.id, username: u.username });
    }
  }

  notices.sort((a, b) => (a.date === b.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));
  return notices;
}
