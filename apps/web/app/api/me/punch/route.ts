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
  // Only a delivery that is still plausibly running reaches this now - an
  // abandoned one is closed and the punch goes through - so the instruction is
  // the true one, and it no longer says "then clock out" to a driver who is
  // trying to clock in.
  OPEN_TRIP_EXISTS: { code: 'OPEN_TRIP_EXISTS', status: 409, message: 'You are still out on an order. Tap BACK at the branch first, then clock in or out.' },
  LOW_GPS_ACCURACY: { code: 'LOW_GPS_ACCURACY', status: 422, message: 'GPS is too weak to confirm you are at the branch. Step outside and try again.' },
  OUT_OF_GEOFENCE: { code: 'OUT_OF_GEOFENCE', status: 422, message: 'You are too far from your branch to clock in. Move closer and try again.' },
  ALREADY_PUNCHED_IN: { code: 'ALREADY_PUNCHED_IN', status: 409, message: 'You are already checked in. Clock out of that shift before starting a new one.' },
  NOT_PUNCHED_IN: { code: 'NOT_PUNCHED_IN', status: 409, message: 'You are not checked in, so there is nothing to clock out of.' },
};

// A refusal that survives self-resolve is a session from a shift-day that is
// NOT over: a duplicate tap, or a second tap during an overnight shift still
// inside its own hours. The employee can fix both themselves by clocking out,
// so the message says that rather than sending them to a manager. A session
// they genuinely finished never reaches here - punchEmployee closes it and
// lets the check-in through.
function blockedMessage(openInAt: Date): string {
  const open = inBeirut(openInAt);
  return (
    `You are already checked in — that shift started ${open.date} ${open.hhmm}. ` +
    `Clock out of it before starting a new one.`
  );
}

// A stale shift the system closed on the employee's behalf. They have to be
// told, or the hours they see will not match the hours they remember working.
function systemClosedMessage(closedAt: Date, kind: 'IN' | 'OUT'): string {
  const at = inBeirut(closedAt);
  const what =
    `Your earlier shift was left open, so it was closed automatically at ` +
    `${at.date} ${at.hhmm} — the hours it was scheduled for.`;
  return kind === 'IN'
    ? `${what} You are now checked in. Tell your manager if you worked later than that.`
    : `${what} You are not clocked in now. Tell your manager if you worked later than that.`;
}

// The system ended a delivery the driver never closed. Their screen still says
// "Out on an order" until it refreshes, and the trip they see disappear is one
// they may believe is still theirs to end - so say what happened and when.
function systemClosedTripMessage(closedAt: Date): string {
  const at = inBeirut(closedAt);
  return (
    `Your order from earlier was never ended, so it was closed automatically at ` +
    `${at.date} ${at.hhmm}. Tell your manager if you were still out after that.`
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
        message: result.openInAt ? blockedMessage(result.openInAt) : mapped.message,
      },
    };
    return NextResponse.json(response, { status: mapped.status });
  }

  await reissueDriverSession(h.get('x-user-role'), userId, h.get('x-user-branch-id'), body.kind);

  // Both closes can land on one punch: a driver who forgot BACK last night and
  // forgot to clock out too. One `notice` field feeds one banner on the phone,
  // so the sentences are joined rather than one of them being dropped.
  const notices: string[] = [];
  if (result.systemClosedAt) notices.push(systemClosedMessage(result.systemClosedAt, body.kind));
  if (result.systemClosedTripAt) notices.push(systemClosedTripMessage(result.systemClosedTripAt));

  const response = {
    ok: true,
    data: {
      at: result.punch.at.toISOString(),
      kind: result.punch.kind,
      minutes_since_in: result.minutes_since_in,
      ...(result.systemClosedAt
        ? {
            system_closed_at: result.systemClosedAt.toISOString(),
            // On a clock-out, `at`/`kind` above describe the system's checkout
            // rather than a punch the employee made. Saying so is the
            // difference between an honest record and a silent substitution.
            system_closed_instead_of_punch: result.systemClosedInsteadOfPunch ?? false,
          }
        : {}),
      ...(result.systemClosedTripAt
        ? { system_closed_trip_at: result.systemClosedTripAt.toISOString() }
        : {}),
      ...(notices.length ? { notice: notices.join(' ') } : {}),
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
