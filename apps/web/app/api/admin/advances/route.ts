import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { prisma } from '@/lib/db/prisma';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const advances = await prisma.advance.findMany({
    where: { status: 'PENDING' },
    orderBy: { created_at: 'asc' },
    include: { user: { select: { id: true, username: true, branch_id: true } } },
  });

  return NextResponse.json({ ok: true, data: { advances } });
}

export const dynamic = 'force-dynamic';