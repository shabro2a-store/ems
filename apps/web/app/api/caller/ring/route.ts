import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { ringDriver } from '@/lib/services/caller';

const Body = z.object({ driverId: z.string().min(1) });

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Ring a driver's phone. The caller may only ring drivers in their own branch.
export async function POST(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'CALLER') return jsonError('FORBIDDEN', 'Caller only', 403);
  const callerId = h.get('x-user-id');
  if (!callerId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', 'driverId is required', 400);
  }

  const caller = await prisma.user.findUnique({ where: { id: callerId }, select: { branch_id: true } });
  if (!caller?.branch_id) return jsonError('NO_BRANCH', 'Caller has no branch assigned', 400);

  const result = await ringDriver({ callerId, driverId: body.driverId, branchId: caller.branch_id, db: prisma });
  if (!result.ok) {
    if (result.code === 'WRONG_BRANCH') return jsonError('WRONG_BRANCH', 'That driver is not in your branch', 403);
    return jsonError('NOT_FOUND', 'Driver not found', 404);
  }
  return NextResponse.json({ ok: true, data: { rang: true } });
}

export const dynamic = 'force-dynamic';
