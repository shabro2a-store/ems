import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { decideAdvance } from '@/lib/services/advances';

const Body = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
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
  } catch {
    return jsonError('INVALID_INPUT', 'Invalid request body', 400);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const result = await decideAdvance({ adminId, advanceId: ctx.params.id, decision: body.decision });

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return jsonError('NOT_FOUND', 'Advance not found', 404);
    if (result.code === 'ALREADY_DECIDED') return jsonError('ALREADY_DECIDED', 'Advance already decided', 409);
    if (result.code === 'INVALID_INPUT') return jsonError('INVALID_INPUT', 'Invalid decision', 400);
  }

  const okResult = result as { ok: true; id: string; status: 'APPROVED' | 'REJECTED' };
  const response = { ok: true, data: { id: okResult.id, status: okResult.status } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';