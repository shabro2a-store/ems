import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { writeAuditLog } from './audit';
import { accruedEarningsThisMonth, monthRangeUtc } from './payout';
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

  // An employee can borrow against everything they've earned this month:
  // worked wages (gross) PLUS bonuses, MINUS deductions. Approved advances are
  // scoped to the same month so the limit refills at the start of each month.
  const { start, end } = monthRangeUtc(input.month);
  const [approvedSum, adjustments, accrued, penalties] = await Promise.all([
    db.advance.aggregate({
      where: { user_id: input.userId, status: 'APPROVED', created_at: { gte: start, lt: end } },
      _sum: { amount_cent: true },
    }),
    db.adjustment.findMany({
      where: { user_id: input.userId, period: { gte: start, lt: end } },
      select: { kind: true, amount_cent: true },
    }),
    accruedEarningsThisMonth(input.userId, input.month, db),
    penaltiesForUser(input.userId, input.month, db),
  ]);

  const approvedBalance = approvedSum._sum.amount_cent ?? 0;
  const adjustmentsCent = adjustments.reduce(
    (s, a) => s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent),
    0,
  );
  const penaltiesCent = sumActivePenaltiesCent(penalties);
  const entitlementCent = accrued.grossCent + adjustmentsCent - penaltiesCent;
  if (approvedBalance + input.amountCent > entitlementCent) {
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
}

export type DecideAdvanceResult =
  | { ok: true; id: string; status: 'APPROVED' | 'REJECTED' }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'INVALID_INPUT' };

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

  const now = new Date();
  const updated = await db.advance.update({
    where: { id: input.advanceId },
    data: { status: input.decision, decided_by: input.adminId, decided_at: now },
  });

  await writeAuditLog({
    actorId: input.adminId,
    action: input.decision === 'APPROVED' ? 'advance.approve' : 'advance.reject',
    entity: 'Advance',
    entityId: input.advanceId,
    before: { status: 'PENDING' },
    after: { status: input.decision },
    db,
  });

  return { ok: true, id: updated.id, status: updated.status as 'APPROVED' | 'REJECTED' };
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