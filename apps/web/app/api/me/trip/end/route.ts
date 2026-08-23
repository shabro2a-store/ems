import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { endTrip } from '@/lib/services/trip';

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
  NO_OPEN_TRIP: { code: 'NO_OPEN_TRIP', status: 409 },
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

  const result = await endTrip({ userId, lat: body.lat, lng: body.lng, accuracy: body.accuracy });

  if (!result.ok) {
    const mapped = ERROR_MAP[result.code] ?? { code: result.code, status: 500 };
    // The driver reads `message` on their phone. NO_OPEN_TRIP became reachable
    // through no fault of theirs the day the system started closing abandoned
    // trips (see tripClose.ts), so it has to explain itself rather than print
    // a code at somebody who cannot act on one.
    const friendly: Record<string, string> = {
      NO_OPEN_TRIP: 'That order was already closed — it had been left open too long, so the system ended it. You have nothing to come back from.',
      OUT_OF_GEOFENCE: 'You are too far from your branch to end the order. Move closer and try again.',
      LOW_GPS_ACCURACY: 'GPS is too weak to confirm you are at the branch. Step outside and try again.',
    };
    const response = { ok: false, error: { code: mapped.code, message: friendly[result.code] ?? `Trip end rejected: ${result.code}` } };
    if (mapped.status >= 400 && mapped.status < 500) {
      await storeIdempotentResponse({ userId, key: idemKey, status_code: mapped.status, response_json: response });
    }
    return NextResponse.json(response, { status: mapped.status });
  }

  const response = { ok: true, data: { trip_id: result.trip_id, back_at: result.back_at.toISOString(), duration_min: result.duration_min } };
  await storeIdempotentResponse({ userId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';