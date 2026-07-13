import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const advances = await prisma.advance.findMany({
    where: { status: 'PENDING' },
    orderBy: { created_at: 'asc' },
    include: { user: { select: { id: true, username: true, branch_id: true } } },
  });

  return NextResponse.json({ ok: true, data: { advances } });
}

export const dynamic = 'force-dynamic';