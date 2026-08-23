import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { inBeirut } from 'time';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { getClientIp, setAccessCookie } from '@/lib/auth/cookies';
import { signToken } from '@/lib/auth/jwt';
import { sessionExpiryFor } from '@/lib/auth/session';
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

// The employee reads `message` verbatim on their phone, so it has to say what
// happened and what to do next. It used to render `Punch rejected: <CODE>` for
// every one of these - a machine token shown to somebody who cannot act on it.
const ERROR_MAP: Record<string, { code: string; status: number; message: string }> = {
  USER_NOT_FOUND: { code: 'UNAUTHORIZED', status: 401, message: 'Your account is not active. Ask your manager.' },
  BRANCH_NOT_FOUND: { code: 'FORBIDDEN', status: 403, message: 'You are not assigned to a branch yet. Ask your manager.' },
  OPEN_TRIP_EXISTS: { code: 'OPEN_TRIP_EXISTS', status: 409, message: 'You are out on an order. Press Back from the trip first, then clock out.' },
  LOW_GPS_ACCURACY: { code: 'LOW_GPS_ACCURACY', status: 422, message: 'GPS is too weak to confirm you are at the branch. Step outside and try again.' },
  OUT_OF_GEOFENCE: { code: 'OUT_OF_GEOFENCE', status: 422, message: 'You are too far from your branch to clock in. Move closer and try again.' },
  ALREADY_PUNCHED_IN: { code: 'ALREADY_PUNCHED_IN', status: 409, message: 'You are still checked in from an earlier shift, so this check-in was refused. Ask your manager to close it.' },
  NOT_PUNCHED_IN: { code: 'NOT_PUNCHED_IN', status: 409, message: 'You are not checked in, so there is nothing to clock out of.' },
};

// The blocked employee is the one person who cannot fix this themselves: the
// open shift is yesterday's and only an admin can close it. So the message
// names the shift in the way, tells them who fixes it, and says their arrival
// is already on the record and paid - otherwise the sane thing to do is stand
// there retrying, or go home, and both cost them money.
function blockedMessage(openInAt: Date, now: Date): string {
  const open = inBeirut(openInAt);
  return (
    `You are still checked in from ${open.date} ${open.hhmm}, so this check-in was refused. ` +
    `Ask your manager to close that shift. Your arrival at ${inBeirut(now).hhmm} is recorded ` +
    `and today's hours count from it.`
  );
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// A driver has to be signed in before they can punch, so "is this driver
// checked in" is always false at login - the only place the session length used
// to be decided. The punch is the moment that answer changes, so the access
// cookie is re-issued here: the checked-in TTL on the way in, the standard one
// on the way out. DRIVER only, and only after the punch actually succeeded.
async function reissueDriverSession(
  role: string | null,
  userId: string,
  branchId: string | null,
  kind: 'IN' | 'OUT',
): Promise<void> {
  if (role !== 'DRIVER') return;
  const now = new Date();
  const exp = sessionExpiryFor({ role: 'DRIVER' }, kind === 'IN', now);
  const token = await signToken({ sub: userId, role: 'DRIVER', branchId }, exp);
  setAccessCookie(token, exp);
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
    const mapped = ERROR_MAP[result.code] ?? {
      code: result.code,
      status: 500,
      message: 'Your punch could not be recorded. Try again, and tell your manager if it keeps failing.',
    };
    const response = {
      ok: false,
      error: {
        code: mapped.code,
        message: result.openInAt ? blockedMessage(result.openInAt, new Date()) : mapped.message,
      },
    };
    return NextResponse.json(response, { status: mapped.status });
  }

  await reissueDriverSession(h.get('x-user-role'), userId, h.get('x-user-branch-id'), body.kind);

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
