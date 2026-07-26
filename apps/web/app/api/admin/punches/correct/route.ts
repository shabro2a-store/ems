import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';

const Body = z.object({
  punchId: z.string().min(1),
  newAt: z.string().datetime().optional(),
  newBranchId: z.string().min(1).optional(),
  reason: z.string().min(1).max(500),
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

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const original = await prisma.punch.findUnique({ where: { id: body.punchId } });
  if (!original) return jsonError('NOT_FOUND', 'Punch not found', 404);

  // Persist the correction to the Punch row (previously this only wrote an audit
  // log and left the row unchanged, so corrections silently did nothing).
  const corrected = await prisma.punch.update({
    where: { id: original.id },
    data: {
      at: body.newAt ? new Date(body.newAt) : original.at,
      branch_id: body.newBranchId ?? original.branch_id,
      corrected: true,
      corrected_by: adminId,
      correction_reason: body.reason,
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'punch.correct',
    entity: 'Punch',
    entityId: original.id,
    before: {
      at: original.at.toISOString(),
      branch_id: original.branch_id,
    },
    after: {
      at: corrected.at.toISOString(),
      branch_id: corrected.branch_id,
      reason: body.reason,
    },
  });

  const response = {
    ok: true,
    data: {
      punch: { ...corrected, at: corrected.at.toISOString() },
      reason: body.reason,
    },
  };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';