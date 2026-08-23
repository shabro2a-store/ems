import type { PrismaClient } from '@prisma/client';
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

function pairHours(punches: PunchRow[], rateChanges: RateChangeRow[]): { minutes: number; grossCent: number } {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  let totalMinutes = 0;
  let grossCent = 0;
  let openIn: PunchRow | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p;
    } else {
      if (openIn) {
        const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
        totalMinutes += minutes;
        const rateCent = rateAt(rateChanges, p.at);
        grossCent += Math.floor((minutes * rateCent) / 60);
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
): { hours: number; grossCent: number } {
  const paired = pairHours(punches, rateChanges);
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
  const { hours, grossCent } = grossWithCredit(args.punches, args.rateChanges, credited);
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
  const [punches, rateChanges, adjustments, approvedAdvances, penalties, overtimeDeductionCent, credits] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: start, lt: end } },
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
  });
}

export async function accruedEarningsThisMonth(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<{ hours: number; grossCent: number }> {
  const { start, end } = monthRangeUtc(month);
  const [punches, rateChanges, credits] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: start, lt: end } },
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
  ]);
  return grossWithCredit(punches as PunchRow[], rateChanges as RateChangeRow[], grantedIntervals(credits));
}