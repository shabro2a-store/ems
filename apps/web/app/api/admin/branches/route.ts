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
  const branches = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ ok: true, data: { branches } });
}

export const dynamic = 'force-dynamic';