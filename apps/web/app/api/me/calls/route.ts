import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const RING_WINDOW_MS = 2 * 60 * 1000;
const DISPATCH_WINDOW_MS = 30 * 60 * 1000;

// The driver's app polls this to know when the caller is ringing (alarm) and
// whether a valid dispatch exists (so it can enable "out on order").
export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
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
