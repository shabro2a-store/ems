import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';
import { payoutForUser } from '@/lib/services/payout';
import { currentShiftDayMinutes, type PunchLite } from '@/lib/services/coverage';
import { abandonedSessionClose, requiredMinForArrival } from '@/lib/services/autoClose';
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

  const [open, payout, punches, creditByUser, me] = await Promise.all([
    currentOpenIn(userId),
    payoutForUser(userId, month, prisma),
    prisma.punch.findMany({
      where: { user_id: userId, at: { gte: punchesFromUtc, lt: endUtc } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    // hours_month comes through payoutForUser and already counts accepted
    // blocked-time credit. Leaving it out of the day figure put two numbers
    // for the same day on the same screen that disagreed.
    grantedCreditMinutesByDate([userId], month, prisma),
    prisma.user.findUnique({
      where: { id: userId },
      select: { branch: { select: { day_start_hour: true } } },
    }),
  ]);

  const dayStartHour = me?.branch?.day_start_hour ?? 0;

  const shiftDay = currentShiftDayMinutes({
    punches: punches as PunchLite[],
    now,
    creditedMinByDate: creditByUser.get(userId),
    dayStartHour,
  });

  // Whether the open session has stopped being a shift at all - past
  // MAX_OPEN_SESSION_MIN. Only then do the field screens hide the clock-out
  // button, because only then is a clock-out something the server will refuse
  // to take at face value.
  //
  // This must NOT be the check-in threshold (`required + grace`). The screens
  // compute `isIn = Boolean(in_at) && !stale` on a 30 second poll, so a night
  // worker sixteen minutes past their grace would watch the button vanish
  // mid-shift - and a driver would lose the trip button with it. Same predicate
  // the clock-out path uses, so the screen and the server cannot disagree.
  const staleOpenSession = open
    ? abandonedSessionClose({
        arrivalAt: open.in_at,
        now,
        requiredMin: await requiredMinForArrival(prisma, userId, open.in_at, dayStartHour),
      }) !== null
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
