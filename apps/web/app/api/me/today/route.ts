import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';
import { payoutForUser } from '@/lib/services/payout';
import { todayInBeirut, todayInBeirutDateRange } from 'time';

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const month = todayInBeirut();
  const { startUtc, endUtc } = todayInBeirutDateRange(month);
  const now = Date.now();

  const [open, user, todayPunches, payout] = await Promise.all([
    currentOpenIn(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { hourly_rate_cent: true } }),
    prisma.punch.findMany({
      where: { user_id: userId, at: { gte: startUtc, lt: endUtc } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    payoutForUser(userId, month.slice(0, 7), prisma),
  ]);

  // Minutes worked today: pair IN->OUT, plus any still-open session up to now.
  let todayMin = 0;
  let openAt: Date | null = null;
  for (const p of todayPunches) {
    if (p.kind === 'IN') { if (!openAt) openAt = p.at; }
    else if (openAt) { todayMin += Math.max(0, Math.floor((p.at.getTime() - openAt.getTime()) / 60_000)); openAt = null; }
  }
  if (openAt) todayMin += Math.max(0, Math.floor((now - openAt.getTime()) / 60_000));
  const rate = user?.hourly_rate_cent ?? 0;
  const earnedTodayCent = Math.floor((todayMin * rate) / 60);

  return NextResponse.json({
    ok: true,
    data: {
      in_at: open ? open.in_at.toISOString() : null,
      minutes_since_in: open ? open.minutes_since_in : null,
      earned_today_cent: earnedTodayCent,
      earned_month_cent: payout.grossCent,
      approved_advance_balance_cent: payout.advancesCent,
      net_cent: payout.netCent,
    },
  });
}

export const dynamic = 'force-dynamic';
