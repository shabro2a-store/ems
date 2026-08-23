import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { abandonedSessionClose, requiredMinForArrival, staleSessionClose, writeSystemCheckout } from '@/lib/services/autoClose';

const DevPunchBody = z.object({
  kind: z.enum(['IN', 'OUT']),
  // No lat/lng/accuracy required — dev override always passes
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  // Gate behind an explicit env var. Available in dev OR when explicitly enabled in prod.
  // Production deployments should set ENABLE_DEV_ENDPOINTS=false (or omit it).
  if (process.env.ENABLE_DEV_ENDPOINTS !== 'true') {
    return jsonError('NOT_FOUND', 'Endpoint not available', 404);
  }

  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }

  let body: z.infer<typeof DevPunchBody>;
  try {
    body = DevPunchBody.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid body: ' + (err instanceof Error ? err.message : 'parse error'), 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { branch: true },
  });
  if (!user || !user.branch) {
    return jsonError('NOT_FOUND', 'User or branch not found', 404);
  }

  // Open session check
  const lastIn = await prisma.punch.findFirst({
    where: { user_id: userId, kind: 'IN' },
    orderBy: { at: 'desc' },
  });
  const lastOut = lastIn
    ? await prisma.punch.findFirst({
        where: { user_id: userId, kind: 'OUT', at: { gt: lastIn.at } },
      })
    : null;
  const hasOpenSession = Boolean(lastIn) && !lastOut;

  // The same stale-session close the real punch route does. It deliberately
  // records NO BlockedPunchAttempt - a blocked attempt is paid time, and it is
  // only sound evidence because the geofence check ran first; this endpoint has
  // no geofence at all, so a row written here would be a paid claim from
  // anywhere. But the close itself has to happen: without it, Dev OUT on a
  // shift left open two days ago writes a checkout at `now` and payroll pays
  // the whole runaway span - the exact hole the real route was just closed for,
  // in an endpoint this deployment leaves enabled.
  let devSystemClosed = false;
  if (hasOpenSession && lastIn) {
    const now = new Date();
    const requiredMin = await requiredMinForArrival(prisma, userId, lastIn.at);
    // Same asymmetry as the real route: a check-in is evidence the old shift
    // ended, a clock-out is the employee asserting the truth about it and may
    // only be overruled past MAX_OPEN_SESSION_MIN.
    const stale =
      body.kind === 'IN'
        ? staleSessionClose({ arrivalAt: lastIn.at, now, requiredMin, graceMin: user.branch.shift_grace_min })
        : abandonedSessionClose({ arrivalAt: lastIn.at, now, requiredMin });
    if (stale) {
      devSystemClosed = true;
      await writeSystemCheckout(prisma, {
        userId,
        branchId: lastIn.branch_id,
        branchLat: user.branch.lat,
        branchLng: user.branch.lng,
        arrivalAt: lastIn.at,
        arrivalPunchId: lastIn.id,
        closeAt: stale.closeAt,
        requiredMin: stale.requiredMin,
        now,
        trigger: body.kind === 'IN' ? 'new_check_in' : 'stale_clock_out',
        reason:
          `Dev punch met a session opened ${lastIn.at.toISOString()} belonging to a shift-day that ` +
          `is over. Closed at check-in plus the ${stale.requiredMin} min that day required.`,
      });
    }
  }

  if (body.kind === 'IN' && hasOpenSession && !devSystemClosed) {
    return jsonError('ALREADY_PUNCHED_IN', 'You have an open session', 409);
  }
  if (body.kind === 'OUT' && !hasOpenSession) {
    return jsonError('NOT_PUNCHED_IN', 'No open session to close', 409);
  }
  if (body.kind === 'OUT' && devSystemClosed) {
    return NextResponse.json({
      ok: true,
      data: { _dev: 'stale session closed at its scheduled hours; no punch written' },
    });
  }

  const now = new Date();
  // Use the user's branch coords as the GPS reading (dev override).
  const punch = await prisma.punch.create({
    data: {
      user_id: userId,
      branch_id: user.branch.id,
      kind: body.kind,
      at: now,
      lat: user.branch.lat,
      lng: user.branch.lng,
      accuracy_m: 10, // synthetic — looks like good GPS
      device_fp: 'dev-override',
      ip: '127.0.0.1',
    },
  });

  await writeAuditLog({
    actorId: userId,
    action: 'punch.dev-override',
    entity: 'Punch',
    entityId: punch.id,
    after: {
      kind: punch.kind,
      at: punch.at.toISOString(),
      branch_id: punch.branch_id,
      note: 'dev-only bypass used (NODE_ENV !== production)',
    },
  });

  // Compute minutes_since_in
  let minutes_since_in: number | null = null;
  if (body.kind === 'IN') {
    minutes_since_in = 0;
  } else if (lastIn) {
    minutes_since_in = Math.max(0, Math.floor((now.getTime() - lastIn.at.getTime()) / 60_000));
  }

  return NextResponse.json({
    ok: true,
    data: {
      at: punch.at.toISOString(),
      kind: punch.kind,
      minutes_since_in,
      _dev: 'punch recorded via dev bypass (no GPS, no geofence check)',
    },
  });
}

export const dynamic = 'force-dynamic';
