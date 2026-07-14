import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { requestLeave, leaveSummary } from '@/lib/services/leave';

const Body = z.object({
  kind: z.enum(['DAY_OFF', 'TIME_CHANGE']),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  note: z.string().max(500).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  const summary = await leaveSummary(userId, prisma);
  return NextResponse.json({ ok: true, data: summary });
}

export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) return jsonError('INVALID_INPUT', 'Idempotency-Key header is required', 400);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const cached = await readIdempotentResponse({ userId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const result = await requestLeave({
    userId,
    kind: body.kind,
    startDate: body.start_date,
    endDate: body.end_date,
    startTime: body.start_time,
    endTime: body.end_time,
    note: body.note,
  });

  if (!result.ok) {
    if (result.code === 'INVALID_INPUT') return jsonError('INVALID_INPUT', 'Invalid dates or times', 400);
    if (result.code === 'PAST_DATE') return jsonError('PAST_DATE', 'start_date must be today or later', 400);
  }

  const okResult = result as { ok: true; id: string; status: 'PENDING' };
  const response = { ok: true, data: { id: okResult.id, status: okResult.status } };
  await storeIdempotentResponse({ userId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';