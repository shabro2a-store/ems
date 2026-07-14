import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const status = url.searchParams.get('status');

  const where: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' } = {};
  if (status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED') where.status = status;

  const requests = await prisma.leaveRequest.findMany({
    where,
    orderBy: { created_at: 'desc' },
    include: { user: { select: { id: true, username: true } } },
  });

  return NextResponse.json({ ok: true, data: { requests } });
}

export const dynamic = 'force-dynamic';