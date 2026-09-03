import type { PrismaClient } from '@prisma/client';
import { shiftDateOf } from 'time';
import { penaltiesForUser, sumActivePenaltiesCent } from './penalty';
import { overtimeDeductionForUser } from './overtime';
import { blockedCreditForUser, grantedIntervals } from './blockedCredit';
import { sumIntervalMinutes, sumIntervalsCent, type WorkInterval } from './coverage';

export interface PayoutForUserResult {
  hours: number;
  grossCent: number;
  // The part of grossCent that is accepted blocked-time credit rather than
  // clocked work. A memo line, not an addend: gross already contains it. The
  // codebase set this standard with overtime_deduction_cent - a figure that
  // moves the total and appears nowhere makes the table stop adding up, and
  // this one silently inflates hours as well as money.
  blockedCreditCent: number;
  blockedCreditMin: number;
  adjustmentsCent: number;
  advancesCent: number;
  penaltiesCent: number;
  overtimeDeductionCent: number;
  netCent: number;
}

interface PunchRow {
  id: string;
  user_id: string;
  kind: 'IN' | 'OUT';
  at: Date;
}

interface RateChangeRow {
  user_id: string;
  rate_cent: number;
  effective_from: Date;
}

interface AdjustmentRow {
  user_id: string;
  kind: 'BONUS' | 'DEDUCTION';
  amount_cent: number;
}

interface AdvanceRow {
  user_id: string;
  amount_cent: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

/**
 * How far either side of the month punches must be loaded before pairing.
 *
 * A shift belongs to the Beirut day it checked IN, which means the pair that
 * decides the last night of the month has its checkout in the NEXT month, and
 * the first night of the month has its arrival in the previous one. Querying
 * the month alone hands `pairHours` an arrival with no checkout at one end and
 * a checkout with no arrival at the other, and it drops both - so a night shift
 * across the boundary was paid nothing, in either month. Not misfiled: lost.
 *
 * Two days is far past MAX_OPEN_SESSION_MIN (30h), which is the longest a
 * session can be before the system closes it, so no real pair reaches outside
 * this window.
 */
export const PAIR_LOOKAROUND_MS = 2 * 86_400_000;

/**
 * The UTC calendar month.
 *
 * Correct for the date-keyed rows that use it - ScheduleOverride.date, penalty
 * and credit dates are all stored as a Beirut date pinned to UTC midnight, so a
 * UTC month selects exactly the right ones. It is NOT the window to pair
 * punches in; see PAIR_LOOKAROUND_MS and pairHours.
 */
export function monthRangeUtc(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`invalid month format: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) throw new Error(`invalid month: ${month}`);
  const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, mon, 1, 0, 0, 0, 0));
  return { start, end };
}

export function rateAt(rateChanges: { rate_cent: number; effective_from: Date }[], at: Date): number {
  for (let i = rateChanges.length - 1; i >= 0; i--) {
    const rc = rateChanges[i]!;
    if (rc.effective_from <= at) return rc.rate_cent;
  }
  return 0;
}

/**
 * Pair IN/OUT and price each pair, keeping only the pairs that belong to
 * `month` - which is decided by the Beirut day of the ARRIVAL, never by the
 * timestamp of either punch.
 *
 * That rule is the same one coverage.ts, the penalty engine and the auto-close
 * all use, and applying it here is what makes a 21:00-07:00 shift on the last
 * night of the month land whole in the month it started, instead of being
 * split down the middle by the boundary and dropped by both sides.
 *
 * With `month` omitted every pair counts, which is what the day-level callers
 * and the property tests want.
 */
function pairHours(
  punches: PunchRow[],
  rateChanges: RateChangeRow[],
  month?: string,
  dayStartHour = 0,
): { minutes: number; grossCent: number } {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  let totalMinutes = 0;
  let grossCent = 0;
  let openIn: PunchRow | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p;
    } else {
      if (openIn) {
        // The arrival's Beirut month, so an overnight pair is counted once, in
        // the month it began. A checkout at 07:00 on the 1st does not move it.
        const belongs =
          month === undefined || shiftDateOf(openIn.at, dayStartHour).slice(0, 7) === month;
        if (belongs) {
          const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
          totalMinutes += minutes;
          const rateCent = rateAt(rateChanges, p.at);
          grossCent += Math.floor((minutes * rateCent) / 60);
        }
        openIn = null;
      }
    }
  }
  return { minutes: totalMinutes, grossCent };
}

/**
 * Worked minutes plus any credited minutes, priced the same way.
 *
 * The credited intervals are the very objects computeCoverage folded into
 * those days, produced once by blockedCredit.ts, and they are summed here by
 * the same per-interval floor coverage prices them with. That is what keeps
 * this month total equal to the sum of each day's grossCent: one pairing, one
 * flooring, one rate instant, and one set of credit figures - never two
 * implementations that have to be kept agreeing by hand.
 */
function grossWithCredit(
  punches: PunchRow[],
  rateChanges: RateChangeRow[],
  creditedIntervals: WorkInterval[],
  month?: string,
  dayStartHour = 0,
): { hours: number; grossCent: number } {
  const paired = pairHours(punches, rateChanges, month, dayStartHour);
  const minutes = paired.minutes + sumIntervalMinutes(creditedIntervals);
  return {
    hours: Math.round((minutes / 60) * 100) / 100,
    grossCent: paired.grossCent + sumIntervalsCent(creditedIntervals),
  };
}

export function computePayoutFromRows(args: {
  userId: string;
  punches: PunchRow[];
  rateChanges: RateChangeRow[];
  adjustments: AdjustmentRow[];
  approvedAdvances: AdvanceRow[];
  penaltiesCent?: number;
  overtimeDeductionCent?: number;
  // Blocked-time credit, already priced, exactly as computeCoverage received
  // it. Paid time with no punch behind it, so it belongs in gross rather than
  // in adjustments: it is hours worked, and the day's own gross already counts
  // it - the two would disagree otherwise, and the penalty ceiling is clamped
  // to that per-day figure.
  creditedIntervals?: WorkInterval[];
  // The month these punches are being paid for, 'YYYY-MM'. Given it, a pair is
  // counted only if its ARRIVAL falls in that Beirut month - which is what
  // stops the night across the boundary being counted twice, or (as it was)
  // zero times. Omit it and every pair counts.
  month?: string;
  /** The branch's working-day start hour; 0 is the calendar day. */
  dayStartHour?: number;
}): PayoutForUserResult {
  const adjustmentsCent = args.adjustments.reduce((s, a) => {
    return s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent);
  }, 0);
  const advancesCent = args.approvedAdvances
    .filter((a) => a.status === 'APPROVED')
    .reduce((s, a) => s + a.amount_cent, 0);
  const penaltiesCent = args.penaltiesCent ?? 0;
  const overtimeDeductionCent = args.overtimeDeductionCent ?? 0;
  const credited = args.creditedIntervals ?? [];
  const { hours, grossCent } = grossWithCredit(
    args.punches,
    args.rateChanges,
    credited,
    args.month,
    args.dayStartHour,
  );
  const netCent = grossCent + adjustmentsCent - advancesCent - penaltiesCent - overtimeDeductionCent;
  return {
    hours,
    grossCent,
    blockedCreditCent: sumIntervalsCent(credited),
    blockedCreditMin: sumIntervalMinutes(credited),
    adjustmentsCent,
    advancesCent,
    penaltiesCent,
    overtimeDeductionCent,
    netCent,
  };
}

export async function payoutForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<PayoutForUserResult> {
  const { start, end } = monthRangeUtc(month);
  // Punches are read wider than the month and then filtered by arrival month
  // inside pairHours; every other row here is date-keyed and takes the month
  // window as-is.
  const pairFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const pairTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const [punches, rateChanges, adjustments, approvedAdvances, penalties, overtimeDeductionCent, credits, user] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: pairFrom, lt: pairTo } },
      orderBy: { at: 'asc' },
      select: { id: true, user_id: true, kind: true, at: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    db.adjustment.findMany({
      where: { user_id: userId, period: { gte: start, lt: end } },
      select: { user_id: true, kind: true, amount_cent: true },
    }),
    db.advance.findMany({
      where: { user_id: userId, status: 'APPROVED', created_at: { gte: start, lt: end } },
      select: { user_id: true, amount_cent: true, status: true },
    }),
    penaltiesForUser(userId, month, db),
    overtimeDeductionForUser(userId, month, db),
    blockedCreditForUser(userId, month, db),
    db.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { day_start_hour: true } } },
    }),
  ]);
  return computePayoutFromRows({
    userId,
    punches: punches as PunchRow[],
    rateChanges: rateChanges as RateChangeRow[],
    adjustments: adjustments as AdjustmentRow[],
    approvedAdvances: approvedAdvances as AdvanceRow[],
    penaltiesCent: sumActivePenaltiesCent(penalties),
    overtimeDeductionCent,
    creditedIntervals: grantedIntervals(credits),
    month,
    dayStartHour: user?.branch?.day_start_hour ?? 0,
  });
}

export async function accruedEarningsThisMonth(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<{ hours: number; grossCent: number }> {
  const { start, end } = monthRangeUtc(month);
  const pairFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const pairTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const [punches, rateChanges, credits, user] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: pairFrom, lt: pairTo } },
      orderBy: { at: 'asc' },
      select: { id: true, user_id: true, kind: true, at: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    // The advance cap is "everything earned this month", and blocked-time
    // credit is earned - leaving it out would lend against a smaller month
    // than payroll is about to pay.
    blockedCreditForUser(userId, month, db),
    db.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { day_start_hour: true } } },
    }),
  ]);
  return grossWithCredit(
    punches as PunchRow[],
    rateChanges as RateChangeRow[],
    grantedIntervals(credits),
    month,
    user?.branch?.day_start_hour ?? 0,
  );
}

export interface RosterUser {
  id: string;
  username: string;
  name: string | null;
  role: string;
  branch_id: string | null;
  hourly_rate_cent: number;
  expected_monthly_salary_cent: number | null;
  deleted_at: Date | null;
  branch: { name: string } | null;
}

/**
 * Who belongs on a month's payroll.
 *
 * Not "everybody active", which is what this used to be and which quietly lost
 * people: deactivate somebody in January and January's payroll stopped listing
 * them, so the month you still owed them for went blank on the screen while
 * their punches sat untouched in the database.
 *
 * Two groups, and the second is the point:
 *
 *  - everybody currently on the staff, so a person who did nothing this month
 *    still shows as a zero row rather than silently vanishing
 *  - anybody at all - deactivated, or retired and gone from every other screen -
 *    who STARTED a shift in this Beirut month
 *
 * That is what makes a retired account behave the way the owner described. The
 * month they worked still lists them, because they have arrivals in it. The
 * month after does not, because they have none - no job sweeps them up and
 * nothing expires; they are simply absent from a query about a month they were
 * not there for.
 *
 * Membership is decided by the ARRIVAL's Beirut month, the same rule pairHours
 * pays by, so the roster and the money can never disagree about which month
 * somebody belongs to - including the night that starts on the 31st.
 */
export async function payrollRoster(
  db: PrismaClient,
  month: string,
  branchId: string | null,
): Promise<RosterUser[]> {
  const { start, end } = monthRangeUtc(month);
  const arrivals = await db.punch.findMany({
    where: {
      kind: 'IN',
      at: {
        gte: new Date(start.getTime() - PAIR_LOOKAROUND_MS),
        lt: new Date(end.getTime() + PAIR_LOOKAROUND_MS),
      },
    },
    select: { user_id: true, at: true },
  });
  // Membership uses each user's own branch boundary, so a night shift that a
  // 6am branch calls the 31st is in that month here too.
  const hourByUser = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(arrivals.map((a) => a.user_id))] } },
        select: { id: true, branch: { select: { day_start_hour: true } } },
      })
    ).map((u) => [u.id, u.branch?.day_start_hour ?? 0]),
  );
  const workedIds = [
    ...new Set(
      arrivals
        .filter((a) => shiftDateOf(a.at, hourByUser.get(a.user_id) ?? 0).slice(0, 7) === month)
        .map((a) => a.user_id),
    ),
  ];

  return db.user.findMany({
    where: {
      role: { in: ['EMPLOYEE', 'DRIVER'] },
      ...(branchId ? { branch_id: branchId } : {}),
      OR: [{ is_active: true, deleted_at: null }, { id: { in: workedIds } }],
    },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      branch_id: true,
      hourly_rate_cent: true,
      expected_monthly_salary_cent: true,
      deleted_at: true,
      branch: { select: { name: true } },
    },
    orderBy: [{ branch: { name: 'asc' } }, { username: 'asc' }],
  });
}
