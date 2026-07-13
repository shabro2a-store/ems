import type { PrismaClient } from '@prisma/client';

export interface PayoutForUserResult {
  hours: number;
  grossCent: number;
  adjustmentsCent: number;
  advancesCent: number;
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

function rateAt(rateChanges: RateChangeRow[], at: Date): number {
  for (let i = rateChanges.length - 1; i >= 0; i--) {
    const rc = rateChanges[i]!;
    if (rc.effective_from <= at) return rc.rate_cent;
  }
  return 0;
}

function pairHours(punches: PunchRow[], rateChanges: RateChangeRow[]): { hours: number; grossCent: number } {
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
  return { hours: Math.round((totalMinutes / 60) * 100) / 100, grossCent };
}

export function computePayoutFromRows(args: {
  userId: string;
  punches: PunchRow[];
  rateChanges: RateChangeRow[];
  adjustments: AdjustmentRow[];
  approvedAdvances: AdvanceRow[];
}): PayoutForUserResult {
  const adjustmentsCent = args.adjustments.reduce((s, a) => {
    return s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent);
  }, 0);
  const advancesCent = args.approvedAdvances
    .filter((a) => a.status === 'APPROVED')
    .reduce((s, a) => s + a.amount_cent, 0);
  const { hours, grossCent } = pairHours(args.punches, args.rateChanges);
  const netCent = grossCent + adjustmentsCent - advancesCent;
  return { hours, grossCent, adjustmentsCent, advancesCent, netCent };
}

export async function payoutForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<PayoutForUserResult> {
  const { start, end } = monthRangeUtc(month);
  const [punches, rateChanges, adjustments, approvedAdvances] = await Promise.all([
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
  ]);
  return computePayoutFromRows({
    userId,
    punches: punches as PunchRow[],
    rateChanges: rateChanges as RateChangeRow[],
    adjustments: adjustments as AdjustmentRow[],
    approvedAdvances: approvedAdvances as AdvanceRow[],
  });
}

export async function accruedEarningsThisMonth(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<{ hours: number; grossCent: number }> {
  const { start, end } = monthRangeUtc(month);
  const [punches, rateChanges] = await Promise.all([
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
  ]);
  return pairHours(punches as PunchRow[], rateChanges as RateChangeRow[]);
}