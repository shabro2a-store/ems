import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { prisma } from '@/lib/db/prisma';
import { currentTrip } from '@/lib/services/trip';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  const userId = me.userId;
  const role = me.role;
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'DRIVER') return jsonError('FORBIDDEN', 'Driver only', 403);

  const info = await currentTrip(userId, prisma);
  return NextResponse.json({ ok: true, data: info });
}

export const dynamic = 'force-dynamic';