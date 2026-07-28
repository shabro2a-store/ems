import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { branchDriverStatuses } from '@/lib/services/caller';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// The caller board: live status of every driver in the caller's branch.
export async function GET() {
  const h = headers();
  if (h.get('x-user-role') !== 'CALLER') return jsonError('FORBIDDEN', 'Caller only', 403);
  const callerId = h.get('x-user-id');
  if (!callerId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const caller = await prisma.user.findUnique({ where: { id: callerId }, select: { branch_id: true, branch: { select: { name: true } } } });
  if (!caller?.branch_id) return jsonError('NO_BRANCH', 'Caller has no branch assigned', 400);

  const drivers = await branchDriverStatuses(caller.branch_id, prisma);
  return NextResponse.json({ ok: true, data: { branch: caller.branch?.name ?? null, drivers } });
}

export const dynamic = 'force-dynamic';
