import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { getClientIp } from '@/lib/auth/cookies';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { consumeTripRateLimit } from '@/lib/services/rateLimitTrip';
import { startTrip, type ReceiptInput } from '@/lib/services/trip';
import { inspectReceiptJpeg } from '@/lib/services/receiptImage';

// Multipart now, not JSON: the receipt photo travels with the trip start, in
// the one request, so a trip cannot be started without it. The coordinates
// arrive as form fields and are coerced.
const Body = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(10_000),
});

const RECEIPT_MESSAGE: Record<string, string> = {
  NOT_JPEG: 'The receipt photo could not be read. Take it again.',
  TOO_SMALL: 'The receipt photo is too small to read. Hold the phone closer and take it again.',
  TOO_LARGE: 'The receipt photo is too large. Take it again.',
};

const RECEIPT_REQUIRED_MESSAGE =
  'Take a photo of the order receipt to go out. If you do not see the camera, reload the app.';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const ERROR_MAP: Record<string, { code: string; status: number }> = {
  USER_NOT_FOUND: { code: 'UNAUTHORIZED', status: 401 },
  BRANCH_NOT_FOUND: { code: 'FORBIDDEN', status: 403 },
  NOT_DRIVER: { code: 'FORBIDDEN', status: 403 },
  NOT_DISPATCHED: { code: 'NOT_DISPATCHED', status: 409 },
  OPEN_TRIP_EXISTS: { code: 'OPEN_TRIP_EXISTS', status: 409 },
  // Mapped explicitly rather than left to the fallback, which is a 500: this is
  // a refusal the driver can act on in one tap, not a server fault, and a 500
  // would also skip the idempotent store below and retry forever.
  NOT_CLOCKED_IN: { code: 'NOT_CLOCKED_IN', status: 409 },
  RECEIPT_REQUIRED: { code: 'RECEIPT_REQUIRED', status: 400 },
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

  // A JSON body is the old screen, from before receipts: it is refused with
  // the same message the driver would get for skipping the photo, and told to
  // reload. It never reaches startTrip, which would refuse it anyway.
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return jsonError('RECEIPT_REQUIRED', RECEIPT_REQUIRED_MESSAGE, 400);
  }

  let body: z.infer<typeof Body>;
  let receipt: ReceiptInput | undefined;
  try {
    const form = await req.formData();
    body = Body.parse({ lat: form.get('lat'), lng: form.get('lng'), accuracy: form.get('accuracy') });
    const photo = form.get('photo');
    if (photo instanceof Blob) {
      const bytes = Buffer.from(await photo.arrayBuffer());
      const inspected = inspectReceiptJpeg(bytes);
      if (!inspected.ok) return jsonError('BAD_PHOTO', RECEIPT_MESSAGE[inspected.reason]!, 400);
      receipt = { bytes, mime: 'image/jpeg', width: inspected.width, height: inspected.height };
    }
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
  const result = await startTrip({ userId, lat: body.lat, lng: body.lng, accuracy: body.accuracy, receipt });

  if (!result.ok) {
    const mapped = ERROR_MAP[result.code] ?? { code: result.code, status: 500 };
    const friendly: Record<string, string> = {
      NOT_DISPATCHED: 'Wait for the counter to call you before going out on an order.',
      NOT_CLOCKED_IN: 'Clock in before going out on an order.',
      RECEIPT_REQUIRED: RECEIPT_REQUIRED_MESSAGE,
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