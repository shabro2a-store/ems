import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';
import { isMonthOpen, CLOSED_MONTH_MESSAGE } from '@/lib/services/periodLock';

const Body = z.object({
  userId: z.string().min(1),
  kind: z.enum(['BONUS', 'DEDUCTION']),
  amountCent: z.number().int().positive(),
  reason: z.string().min(1).max(500),
  // The month the owner is LOOKING at. Without it this route stamped the
  // period from the server clock, so a bonus added while reviewing January was
  // silently written into the current month: January never changed, and the
  // live month grew an adjustment nobody could trace back to a decision.
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) return jsonError('INVALID_INPUT', 'Idempotency-Key header is required', 400);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  if (!isMonthOpen(body.month)) {
    return jsonError('MONTH_CLOSED', CLOSED_MONTH_MESSAGE, 409);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  // The first of the month at UTC midnight, matching how monthRangeUtc selects
  // adjustments back out.
  const [y, m] = body.month.split('-').map(Number);
  const period = new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0, 0));

  const adjustment = await prisma.adjustment.create({
    data: {
      user_id: body.userId,
      period,
      kind: body.kind,
      amount_cent: body.amountCent,
      reason: body.reason,
      created_by: adminId,
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'adjustment.create',
    entity: 'Adjustment',
    entityId: adjustment.id,
    after: { user_id: adjustment.user_id, kind: adjustment.kind, amount_cent: adjustment.amount_cent, period: period.toISOString().slice(0, 10) },
  });

  const response = { ok: true, data: { adjustment } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';