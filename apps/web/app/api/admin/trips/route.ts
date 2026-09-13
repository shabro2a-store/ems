import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { monthRangeUtc, rateAt, tripDayResolver, PAIR_LOOKAROUND_MS } from '@/lib/services/payout';
import { dayStartHourFor, type PunchLite } from '@/lib/services/coverage';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * One driver's completed trips in one month, grouped by the working day of the
 * SHIFT each happened in, each priced at the per-trip rate in force at that
 * moment.
 *
 * The same rule tripPay uses to reach the payroll figure, applied trip by trip
 * so the total here and the Trips column cannot disagree: this list IS that
 * figure, itemised. A trip still out is not listed - it has not been completed
 * and is not yet owed.
 */
export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId') ?? '';
  const month = url.searchParams.get('month') ?? '';
  if (!userId || !/^\d{4}-\d{2}$/.test(month)) {
    return jsonError('INVALID_INPUT', 'userId and month (YYYY-MM) are required', 400);
  }

  // The same widened window payroll reads, and the same shift resolver, so a
  // trip lands on the same day here as in the Trips column - the list IS that
  // figure, itemised. A trip at 00:30 on the 1st during a shift that started
  // the night before is the previous month's, and only the punches know that.
  const { start, end } = monthRangeUtc(month);
  const from = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const to = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const [trips, rates, punches, user] = await Promise.all([
    prisma.trip.findMany({
      where: { driver_id: userId, out_at: { gte: from, lt: to }, back_at: { not: null } },
      orderBy: { out_at: 'asc' },
      select: {
        id: true,
        out_at: true,
        back_at: true,
        system_generated: true,
        branch: { select: { name: true } },
      },
    }),
    prisma.tripRateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { rate_cent: true, effective_from: true },
    }),
    prisma.punch.findMany({
      where: { user_id: userId, at: { gte: from, lt: to } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { day_start_hour: true } }),
  ]);
  const dayOf = tripDayResolver(punches as PunchLite[], dayStartHourFor(user));

  const byDay = new Map<
    string,
    {
      date: string;
      count: number;
      cent: number;
      trips: Array<{ id: string; out_at: string; back_at: string | null; branch: string; system_closed: boolean; rate_cent: number }>;
    }
  >();
  for (const t of trips) {
    const date = dayOf(t.out_at);
    if (date.slice(0, 7) !== month) continue; // the window is wider than the month on purpose
    const rate = rateAt(rates, t.out_at);
    const day = byDay.get(date) ?? { date, count: 0, cent: 0, trips: [] };
    day.count += 1;
    day.cent += rate;
    day.trips.push({
      id: t.id,
      out_at: t.out_at.toISOString(),
      back_at: t.back_at?.toISOString() ?? null,
      branch: t.branch.name,
      system_closed: t.system_generated,
      rate_cent: rate,
    });
    byDay.set(date, day);
  }

  return NextResponse.json({ ok: true, data: { days: [...byDay.values()] } });
}

export const dynamic = 'force-dynamic';
