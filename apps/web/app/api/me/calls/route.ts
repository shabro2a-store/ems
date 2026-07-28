import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const RING_WINDOW_MS = 2 * 60 * 1000;

// The driver's app polls this to know when the caller is ringing.
export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const call = await prisma.driverCall.findFirst({
    where: { driver_id: userId, acknowledged_at: null, created_at: { gte: new Date(Date.now() - RING_WINDOW_MS) } },
    orderBy: { created_at: 'desc' },
    select: { id: true, created_at: true },
  });

  return NextResponse.json({
    ok: true,
    data: { ringing: Boolean(call), since: call ? call.created_at.toISOString() : null },
  });
}

export const dynamic = 'force-dynamic';
