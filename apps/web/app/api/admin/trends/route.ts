import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { inBeirut, todayInBeirut, todayInBeirutDateRange } from 'time';
import { beirutDateSeries } from '@/lib/services/noticeWindow';

// Per-day trend for the dashboard chart: for each of the last N Beirut days,
// how many distinct staff were present and how many hours were worked.
// Branch-filterable via ?branchId=<id>.

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

  // Both the date list and the query bound come from the calendar. Stepping an
  // instant back 24h at a time repeats one date and skips another either side
  // of a DST change, and the repeat collapses in the idx Map below - so one bar
  // would read zero and the short day would never appear at all.
  const dateList = beirutDateSeries(todayInBeirut(new Date(now)), days);
  const from = todayInBeirutDateRange(dateList[0]!).startUtc;

  const punches = await prisma.punch.findMany({
    where: { at: { gte: from }, ...(branchId ? { branch_id: branchId } : {}) },
    orderBy: { at: 'asc' },
    select: { user_id: true, kind: true, at: true },
  });

  const idx = new Map(dateList.map((d, i) => [d, i]));

  const present: Set<string>[] = dateList.map(() => new Set());
  const minutes: number[] = dateList.map(() => 0);
  // pairing state per (date,user)
  const openIn = new Map<string, Date>();

  for (const p of punches) {
    const day = inBeirut(p.at).date;
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
