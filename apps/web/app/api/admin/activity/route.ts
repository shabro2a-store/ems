import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

// Recent activity feed for the dashboard: punches + trips merged, newest first.
// Branch-filterable via ?branchId=<id> ('all' or omitted = every branch).

export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const branchParam = url.searchParams.get('branchId');
  const branchId = branchParam && branchParam !== 'all' ? branchParam : null;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 100);

  const [punches, trips] = await Promise.all([
    prisma.punch.findMany({
      where: branchId ? { branch_id: branchId } : {},
      orderBy: { at: 'desc' },
      take: 40,
      select: { id: true, kind: true, at: true, user: { select: { username: true } } },
    }),
    prisma.trip.findMany({
      where: branchId ? { branch_id: branchId } : {},
      orderBy: { out_at: 'desc' },
      take: 25,
      select: { id: true, out_at: true, back_at: true, driver: { select: { username: true } } },
    }),
  ]);

  type Ev = { id: string; type: 'IN' | 'OUT' | 'TRIP_OUT' | 'TRIP_BACK'; username: string; at: string };
  const events: Ev[] = [];
  for (const p of punches) {
    events.push({ id: `p-${p.id}`, type: p.kind === 'IN' ? 'IN' : 'OUT', username: p.user.username, at: p.at.toISOString() });
  }
  for (const t of trips) {
    events.push({ id: `to-${t.id}`, type: 'TRIP_OUT', username: t.driver.username, at: t.out_at.toISOString() });
    if (t.back_at) {
      events.push({ id: `tb-${t.id}`, type: 'TRIP_BACK', username: t.driver.username, at: t.back_at.toISOString() });
    }
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return NextResponse.json({ ok: true, data: { events: events.slice(0, limit) } });
}

export const dynamic = 'force-dynamic';
