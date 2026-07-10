import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { getClientIp } from '@/lib/auth/cookies';
import { consumePunchRateLimit } from '@/lib/services/rateLimit';
import {
  readIdempotentResponse,
  storeIdempotentResponse,
} from '@/lib/services/idempotency';
import { punchEmployee } from '@/lib/services/punch';

const PunchBody = z.object({
  kind: z.enum(['IN', 'OUT']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000),
  deviceFp: z.string().min(1).max(128),
});

const ERROR_MAP: Record<string, { code: string; status: number }> = {
  USER_NOT_FOUND: { code: 'UNAUTHORIZED', status: 401 },
  BRANCH_NOT_FOUND: { code: 'FORBIDDEN', status: 403 },
  DAY_OFF_PUNCH_BLOCKED: { code: 'DAY_OFF_PUNCH_BLOCKED', status: 409 },
  OPEN_TRIP_EXISTS: { code: 'OPEN_TRIP_EXISTS', status: 409 },
  LOW_GPS_ACCURACY: { code: 'LOW_GPS_ACCURACY', status: 422 },
  OUT_OF_GEOFENCE: { code: 'OUT_OF_GEOFENCE', status: 422 },
  ALREADY_PUNCHED_IN: { code: 'ALREADY_PUNCHED_IN', status: 409 },
  NOT_PUNCHED_IN: { code: 'NOT_PUNCHED_IN', status: 409 },
};

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) {
    return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  }

  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) {
    return jsonError('INVALID_INPUT', 'Idempotency-Key header is required', 400);
  }

  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }

  let body: z.infer<typeof PunchBody>;
  try {
    body = PunchBody.parse(await req.json());
  } catch (err) {
    return jsonError(
      'INVALID_INPUT',
      'Invalid request body: ' + (err instanceof z.ZodError ? err.message : 'parse error'),
      400,
    );
  }

  const cached = await readIdempotentResponse({ userId, key: idemKey });
  if (cached) {
    return NextResponse.json(cached.response_json, { status: cached.status_code });
  }

  const rate = await consumePunchRateLimit({ userId });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `Too many punch attempts. Retry in ${rate.retryAfterSec}s.`,
        },
      },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSec ?? 60) },
      },
    );
  }

  const ip = getClientIp(req);
  const result = await punchEmployee({
    userId,
    kind: body.kind,
    lat: body.lat,
    lng: body.lng,
    accuracy: body.accuracy,
    deviceFp: body.deviceFp,
    ip,
  });

  if ('code' in result) {
    const mapped = ERROR_MAP[result.code] ?? { code: result.code, status: 500 };
    const response = {
      ok: false,
      error: { code: mapped.code, message: `Punch rejected: ${result.code}` },
    };
    return NextResponse.json(response, { status: mapped.status });
  }

  const response = {
    ok: true,
    data: {
      at: result.punch.at.toISOString(),
      kind: result.punch.kind,
      minutes_since_in: result.minutes_since_in,
    },
  };

  await storeIdempotentResponse({
    userId,
    key: idemKey,
    status_code: 200,
    response_json: response,
  });

  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
