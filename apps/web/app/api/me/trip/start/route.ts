import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { getClientIp } from '@/lib/auth/cookies';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { consumeTripRateLimit } from '@/lib/services/rateLimitTrip';
import { startTrip } from '@/lib/services/trip';

const Body = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const ERROR_MAP: Record<string, { code: string; status: number }> = {
  USER_NOT_FOUND: { code: 'UNAUTHORIZED', status: 401 },
  BRANCH_NOT_FOUND: { code: 'FORBIDDEN', status: 403 },
  NOT_DRIVER: { code: 'FORBIDDEN', status: 403 },
  NOT_DISPATCHED: { code: 'NOT_DISPATCHED', status: 409 },
  OPEN_TRIP_EXISTS: { code: 'OPEN_TRIP_EXISTS', status: 409 },
  OUT_OF_GEOFENCE: { code: 'OUT_OF_GEOFENCE', status: 422 },
  LOW_GPS_ACCURACY: { code: 'LOW_GPS_ACCURACY', status: 422 },
};

export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  const role = h.get('x-user-role');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'DRIVER') return jsonError('FORBIDDEN', 'Driver only', 403);

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

  const rate = await consumeTripRateLimit({ userId });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: 'RATE_LIMITED', message: `Too many trip requests. Retry in ${rate.retryAfterSec}s.` } },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec ?? 60) } },
    );
  }

  const ip = getClientIp(req);
  void ip;
  const result = await startTrip({ userId, lat: body.lat, lng: body.lng, accuracy: body.accuracy });

  if (!result.ok) {
    const mapped = ERROR_MAP[result.code] ?? { code: result.code, status: 500 };
    const friendly: Record<string, string> = {
      NOT_DISPATCHED: 'Wait for the counter to call you before going out on an order.',
    };
    const response = { ok: false, error: { code: mapped.code, message: friendly[result.code] ?? `Trip rejected: ${result.code}` } };
    if (mapped.status >= 400 && mapped.status < 500) {
      await storeIdempotentResponse({ userId, key: idemKey, status_code: mapped.status, response_json: response });
    }
    return NextResponse.json(response, { status: mapped.status });
  }

  const response = { ok: true, data: { trip_id: result.trip_id, out_at: result.out_at.toISOString() } };
  await storeIdempotentResponse({ userId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';