import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { writeAuditLog } from './audit';
import { accruedEarningsThisMonth, monthRangeUtc } from './payout';
import { advancePayMonth, approvedAdvancesForMonth } from './advanceMonth';
import { penaltiesForUser, sumActivePenaltiesCent } from './penalty';
import { getNotifier, type Notifier } from 'notify';

export interface RequestAdvanceInput {
  userId: string;
  amountCent: number;
  reason?: string | null;
  month: string;
  db?: PrismaClient;
  notifier?: Notifier;
}

export interface RequestAdvanceOk {
  ok: true;
  id: string;
  status: 'PENDING';
}

export type RequestAdvanceResult =
  | RequestAdvanceOk
  | { ok: false; code: 'EXCEEDS_ACCRUED_EARNINGS' }
  | { ok: false; code: 'INVALID_INPUT' };

export async function requestAdvance(
  input: RequestAdvanceInput,
): Promise<RequestAdvanceResult> {
  const db = input.db ?? defaultPrisma;
  if (!Number.isInteger(input.amountCent) || input.amountCent <= 0) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  // An employee can borrow against everything they've earned this month, and
  // the requests still waiting for an answer are already spoken for: counting
  // only approved ones let three $200 requests through on $250 earned.
  const [earnedCent, approved, pending] = await Promise.all([
    entitlementCent(input.userId, input.month, db),
    approvedAdvancesForMonth(db, input.userId, input.month),
    db.advance.aggregate({
      where: { user_id: input.userId, status: 'PENDING' },
      _sum: { amount_cent: true },
    }),
  ]);
  const committedCent = sumCents(approved) + (pending._sum.amount_cent ?? 0);
  if (committedCent + input.amountCent > earnedCent) {
    return { ok: false, code: 'EXCEEDS_ACCRUED_EARNINGS' };
  }

  const advance = await db.advance.create({
    data: {
      user_id: input.userId,
      amount_cent: input.amountCent,
      reason: input.reason ?? null,
      status: 'PENDING',
    },
  });

  await writeAuditLog({
    actorId: input.userId,
    action: 'advance.create',
    entity: 'Advance',
    entityId: advance.id,
    after: { amount_cent: advance.amount_cent, status: advance.status },
    db,
  });

  const requester = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, username: true, name: true },
  });
  await (input.notifier ?? getNotifier()).send({
    channel: 'telegram',
    recipient: 'admin',
    template: 'advance_requested',
    context: {
      user: { id: input.userId, username: requester?.name ?? requester?.username ?? 'Employee' },
      amount: advance.amount_cent,
      reason: input.reason ?? null,
    },
  });

  return { ok: true, id: advance.id, status: 'PENDING' };
}

export interface DecideAdvanceInput {
  adminId: string;
  advanceId: string;
  decision: 'APPROVED' | 'REJECTED';
  db?: PrismaClient;
  now?: Date;
}

export type DecideAdvanceResult =
  | { ok: true; id: string; status: 'APPROVED' | 'REJECTED' }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'INVALID_INPUT' }
  | { ok: false; code: 'EXCEEDS_ACCRUED_EARNINGS'; month: string; earnedCent: number; advancedCent: number };

export async function decideAdvance(
  input: DecideAdvanceInput,
): Promise<DecideAdvanceResult> {
  const db = input.db ?? defaultPrisma;
  if (input.decision !== 'APPROVED' && input.decision !== 'REJECTED') {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const advance = await db.advance.findUnique({ where: { id: input.advanceId } });
  if (!advance) return { ok: false, code: 'NOT_FOUND' };
  if (advance.status !== 'PENDING') return { ok: false, code: 'ALREADY_DECIDED' };

  const now = input.now ?? new Date();
  if (input.decision === 'APPROVED') {
    // The cap again, at the moment money is handed over: earnings can have
    // shrunk since the request (a penalty, a correction), and other requests
    // may have been approved in between. Refusing is always allowed.
    const month = advancePayMonth({ created_at: advance.created_at, decided_at: now });
    const [earnedCent, approved] = await Promise.all([
      entitlementCent(advance.user_id, month, db),
      approvedAdvancesForMonth(db, advance.user_id, month, advance.id),
    ]);
    const advancedCent = sumCents(approved);
    if (advancedCent + advance.amount_cent > earnedCent) {
      return { ok: false, code: 'EXCEEDS_ACCRUED_EARNINGS', month, earnedCent, advancedCent };
    }
  }

  // Only a request that is still pending, so two clicks cannot both decide it.
  const { count } = await db.advance.updateMany({
    where: { id: input.advanceId, status: 'PENDING' },
    data: { status: input.decision, decided_by: input.adminId, decided_at: now },
  });
  if (count === 0) return { ok: false, code: 'ALREADY_DECIDED' };

  await writeAuditLog({
    actorId: input.adminId,
    action: input.decision === 'APPROVED' ? 'advance.approve' : 'advance.reject',
    entity: 'Advance',
    entityId: input.advanceId,
    before: { status: 'PENDING' },
    after: { status: input.decision },
    db,
  });

  return { ok: true, id: input.advanceId, status: input.decision };
}

/** What one person has earned in `month` that can be lent against: gross, bonuses in, deductions and penalties out. */
async function entitlementCent(userId: string, month: string, db: PrismaClient): Promise<number> {
  // `period` is a date marker at UTC midnight, so the UTC month matches it exactly.
  const { start, end } = monthRangeUtc(month);
  const [adjustments, accrued, penalties] = await Promise.all([
    db.adjustment.findMany({
      where: { user_id: userId, period: { gte: start, lt: end } },
      select: { kind: true, amount_cent: true },
    }),
    accruedEarningsThisMonth(userId, month, db),
    penaltiesForUser(userId, month, db),
  ]);
  const adjustmentsCent = adjustments.reduce((s, a) => s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent), 0);
  return accrued.grossCent + adjustmentsCent - sumActivePenaltiesCent(penalties);
}

function sumCents(rows: Array<{ amount_cent: number }>): number {
  return rows.reduce((s, r) => s + r.amount_cent, 0);
}

export interface AdvanceSummary {
  pending: number;
  approved_balance_cent: number;
}

export async function advancesSummary(
  userId: string,
  db: PrismaClient = defaultPrisma,
): Promise<AdvanceSummary> {
  const [pendingCount, approvedSum] = await Promise.all([
    db.advance.count({ where: { user_id: userId, status: 'PENDING' } }),
    db.advance.aggregate({
      where: { user_id: userId, status: 'APPROVED' },
      _sum: { amount_cent: true },
    }),
  ]);
  return { pending: pendingCount, approved_balance_cent: approvedSum._sum.amount_cent ?? 0 };
}