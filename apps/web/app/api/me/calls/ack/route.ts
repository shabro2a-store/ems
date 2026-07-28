import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Driver dismisses the alarm — acknowledge all their pending rings.
export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  await prisma.driverCall.updateMany({
    where: { driver_id: userId, acknowledged_at: null },
    data: { acknowledged_at: new Date() },
  });
  return NextResponse.json({ ok: true, data: { acknowledged: true } });
}

export const dynamic = 'force-dynamic';
