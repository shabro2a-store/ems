import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { writeAuditLog } from './audit';
import { accruedEarningsThisMonth } from './payout';

export interface RequestAdvanceInput {
  userId: string;
  amountCent: number;
  reason?: string | null;
  month: string;
  db?: PrismaClient;
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

  const [approvedSum, accrued] = await Promise.all([
    db.advance.aggregate({
      where: { user_id: input.userId, status: 'APPROVED' },
      _sum: { amount_cent: true },
    }),
    accruedEarningsThisMonth(input.userId, input.month, db),
  ]);

  const approvedBalance = approvedSum._sum.amount_cent ?? 0;
  if (approvedBalance + input.amountCent > accrued.grossCent) {
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