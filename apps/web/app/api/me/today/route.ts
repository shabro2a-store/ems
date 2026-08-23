import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';
import { payoutForUser } from '@/lib/services/payout';
import { currentShiftDayMinutes, type PunchLite } from '@/lib/services/coverage';
import { requiredMinForArrival, staleSessionClose } from '@/lib/services/autoClose';
import { grantedCreditMinutesByDate } from '@/lib/services/blockedCredit';
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

  const [open, payout, punches, user, creditByUser] = await Promise.all([
    currentOpenIn(userId),
    payoutForUser(userId, month, prisma),
    prisma.punch.findMany({
      where: { user_id: userId, at: { gte: punchesFromUtc, lt: endUtc } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { shift_grace_min: true } } },
    }),
    // hours_month comes through payoutForUser and already counts accepted
    // blocked-time credit. Leaving it out of the day figure put two numbers
    // for the same day on the same screen that disagreed.
    grantedCreditMinutesByDate([userId], month, prisma),
  ]);

  const shiftDay = currentShiftDayMinutes({
    punches: punches as PunchLite[],
    now,
    creditedMinByDate: creditByUser.get(userId),
  });

  // Whether the open session belongs to a shift-day that is over. The field
  // screens must not offer a bare clock-out on one: tapping it wrote a checkout
  // at `now` and payroll paid the entire runaway span, which is exactly the
  // failure the auto-close exists to prevent - and it meant the employee never
  // saw the block at all. Same predicate punch.ts uses to decide whether to
  // close the session itself, so the screen and the server cannot disagree.
  const staleOpenSession = open
    ? (await (async () => {
        const requiredMin = await requiredMinForArrival(prisma, userId, open.in_at);
        return (
          staleSessionClose({
            arrivalAt: open.in_at,
            now,
            requiredMin,
            graceMin: user?.branch?.shift_grace_min ?? 15,
          }) !== null
        );
      })())
    : false;

  return NextResponse.json({
    ok: true,
    data: {
      in_at: open ? open.in_at.toISOString() : null,
      // Elapsed time on the session open right now. The driver's "On shift"
      // tile wants exactly this; a tile labelled "Today" does not.
      minutes_since_in: open ? open.minutes_since_in : null,
      minutes_today: shiftDay.minutes,
      hours_month: payout.hours,
      open_session_stale: staleOpenSession,
    },
  });
}

export const dynamic = 'force-dynamic';
