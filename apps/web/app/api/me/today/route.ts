import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';
import { payoutForUser } from '@/lib/services/payout';
import { currentShiftDayMinutes, type PunchLite } from '@/lib/services/coverage';
import { todayInBeirut, todayInBeirutDateRange } from 'time';

// A shift belongs to the Beirut day it started, so the day total has to see an
// arrival that happened before today's midnight. Two days is far more than any
// real shift and cheaper than being clever.
const PUNCH_LOOKBACK_DAYS = 2;

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const now = new Date();
  const todayStr = todayInBeirut(now);
  const month = todayStr.slice(0, 7);
  const { startUtc, endUtc } = todayInBeirutDateRange(todayStr);
  const punchesFromUtc = new Date(startUtc.getTime() - PUNCH_LOOKBACK_DAYS * 86_400_000);

  const [open, payout, punches] = await Promise.all([
    currentOpenIn(userId),
    payoutForUser(userId, month, prisma),
    prisma.punch.findMany({
      where: { user_id: userId, at: { gte: punchesFromUtc, lt: endUtc } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
  ]);

  const shiftDay = currentShiftDayMinutes({ punches: punches as PunchLite[], now });

  return NextResponse.json({
    ok: true,
    data: {
      in_at: open ? open.in_at.toISOString() : null,
      // Elapsed time on the session open right now. The driver's "On shift"
      // tile wants exactly this; a tile labelled "Today" does not.
      minutes_since_in: open ? open.minutes_since_in : null,
      minutes_today: shiftDay.minutes,
      hours_month: payout.hours,
    },
  });
}

export const dynamic = 'force-dynamic';
