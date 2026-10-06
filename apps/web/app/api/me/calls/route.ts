import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { prisma } from '@/lib/db/prisma';
import { RING_WINDOW_MS } from '@/lib/services/caller';
import { DISPATCH_WINDOW_MS } from '@/lib/services/trip';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// The driver's app polls this to know when the caller is ringing (alarm) and
// whether a valid dispatch exists (so it can enable "out on order").
export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  const userId = me.userId;
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const now = Date.now();
  const [ring, dispatch] = await Promise.all([
    prisma.driverCall.findFirst({
      where: { driver_id: userId, acknowledged_at: null, created_at: { gte: new Date(now - RING_WINDOW_MS) } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    }),
    prisma.driverCall.findFirst({
      where: { driver_id: userId, trip_id: null, created_at: { gte: new Date(now - DISPATCH_WINDOW_MS) } },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    data: {
      ringing: Boolean(ring),
      since: ring ? ring.created_at.toISOString() : null,
      canGoOut: Boolean(dispatch),
    },
  });
}

export const dynamic = 'force-dynamic';
