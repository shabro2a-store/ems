import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { todayInBeirut } from 'time';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { consumeAdvanceRateLimit } from '@/lib/services/rateLimitAdvance';
import { requestAdvance, advancesSummary } from '@/lib/services/advances';

const Body = z.object({
  amountCent: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  const url = new URL(req.url);
  if (url.searchParams.get('view') === 'list') {
    const advances = await prisma.advance.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return NextResponse.json({ ok: true, data: { advances } });
  }
  const summary = await advancesSummary(userId, prisma);
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

  const rate = await consumeAdvanceRateLimit({ userId });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: 'RATE_LIMITED', message: `Too many advance requests. Retry in ${rate.retryAfterSec}s.` } },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec ?? 60) } },
    );
  }

  const month = todayInBeirut().slice(0, 7);
  const result = await requestAdvance({
    userId,
    amountCent: body.amountCent,
    reason: body.reason ?? null,
    month,
  });

  if (!result.ok) {
    if (result.code === 'EXCEEDS_ACCRUED_EARNINGS') {
      const response = { ok: false, error: { code: 'EXCEEDS_ACCRUED_EARNINGS', message: 'Advance exceeds accrued earnings this month.' } };
      await storeIdempotentResponse({ userId, key: idemKey, status_code: 409, response_json: response });
      return NextResponse.json(response, { status: 409 });
    }
    if (result.code === 'INVALID_INPUT') {
      const response = { ok: false, error: { code: 'INVALID_INPUT', message: 'Amount must be a positive integer.' } };
      return NextResponse.json(response, { status: 400 });
    }
  }

  const okResult = result as { ok: true; id: string; status: 'PENDING' };
  const response = { ok: true, data: { id: okResult.id, status: okResult.status } };
  await storeIdempotentResponse({ userId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';