import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

// Per-day trend for the dashboard chart: for each of the last N Beirut days,
// how many distinct staff were present and how many hours were worked.
// Branch-filterable via ?branchId=<id>.

function beirutDate(d: Date): string {
  // en-CA yields YYYY-MM-DD
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
}

export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const branchParam = url.searchParams.get('branchId');
  const branchId = branchParam && branchParam !== 'all' ? branchParam : null;
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 31);

  const now = Date.now();
  const from = new Date(now - days * 24 * 60 * 60 * 1000);

  const punches = await prisma.punch.findMany({
    where: { at: { gte: from }, ...(branchId ? { branch_id: branchId } : {}) },
    orderBy: { at: 'asc' },
    select: { user_id: true, kind: true, at: true },
  });

  // Ordered list of the last `days` Beirut date strings (oldest first).
  const dateList: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dateList.push(beirutDate(new Date(now - i * 24 * 60 * 60 * 1000)));
  }
  const idx = new Map(dateList.map((d, i) => [d, i]));

  const present: Set<string>[] = dateList.map(() => new Set());
  const minutes: number[] = dateList.map(() => 0);
  // pairing state per (date,user)
  const openIn = new Map<string, Date>();

  for (const p of punches) {
    const day = beirutDate(p.at);
    const i = idx.get(day);
    if (i === undefined) continue;
    const key = `${day}|${p.user_id}`;
    if (p.kind === 'IN') {
      present[i]!.add(p.user_id);
      if (!openIn.has(key)) openIn.set(key, p.at);
    } else {
      const inAt = openIn.get(key);
      if (inAt) {
        minutes[i]! += Math.max(0, Math.floor((p.at.getTime() - inAt.getTime()) / 60_000));
        openIn.delete(key);
      }
    }
  }
  // Close still-open sessions on today's row up to now.
  for (const [key, inAt] of openIn) {
    const day = key.split('|')[0]!;
    const i = idx.get(day);
    if (i === undefined) continue;
    minutes[i]! += Math.max(0, Math.floor((now - inAt.getTime()) / 60_000));
  }

  const points = dateList.map((date, i) => ({
    date,
    label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short' }),
    present: present[i]!.size,
    hours: Math.round((minutes[i]! / 60) * 10) / 10,
  }));

  return NextResponse.json({ ok: true, data: { points } });
}

export const dynamic = 'force-dynamic';
