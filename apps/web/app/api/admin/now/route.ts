import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

interface PresentUser {
  id: string;
  username: string;
  in_at: string;
  minutes_since_in: number;
  branch_id: string;
}

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') {
    return NextResponse.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } },
      { status: 403 },
    );
  }

  const branches = await prisma.branch.findMany({
    where: { is_active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      users: {
        where: { is_active: true },
        select: {
          id: true,
          username: true,
          role: true,
          punches: {
            orderBy: { at: 'desc' },
            take: 1,
            select: { kind: true, at: true },
          },
        },
      },
    },
  });

  const now = Date.now();
  const data = branches.map((b) => {
    const present: PresentUser[] = [];
    const absent: { id: string; username: string; role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' }[] = [];
    for (const u of b.users) {
      const last = u.punches[0];
      if (last && last.kind === 'IN') {
        const minutes_since_in = Math.max(0, Math.floor((now - last.at.getTime()) / 60_000));
        present.push({
          id: u.id,
          username: u.username,
          in_at: last.at.toISOString(),
          minutes_since_in,
          branch_id: b.id,
        });
      } else {
        absent.push({ id: u.id, username: u.username, role: u.role });
      }
    }
    return {
      id: b.id,
      name: b.name,
      present,
      absent,
      driversOut: [],
    };
  });

  return NextResponse.json({ ok: true, data: { branches: data, flags: [] } });
}

export const dynamic = 'force-dynamic';
