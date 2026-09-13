import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { todayInBeirut, previousBeirutDate, nextBeirutDate } from 'time';
import { prisma } from '@/lib/db/prisma';
import { dayReviewState, reviewDeadline, tripLocked, loadReviewWindow, type ReviewTrip, type DayReviewState } from '@/lib/services/tripReview';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/** How many days back the "still to review" strip looks. Past the 48-hour window nothing is open anyway. */
const PENDING_DAYS = 4;

function tripJson(t: ReviewTrip, locked: boolean) {
  return {
    id: t.id,
    out_at: t.out_at.toISOString(),
    back_at: t.back_at?.toISOString() ?? null,
    branch: t.branch.name,
    system_closed: t.system_generated,
    // available: the photo can be fetched. wiped: there was one, the weekly
    // wipe took it. none: a trip from before receipts existed.
    receipt: t.receipt ? 'available' : t.receipt_taken_at ? 'wiped' : 'none',
    denied_at: t.denied_at?.toISOString() ?? null,
    denied_reason: t.denied_reason,
    reviewed_at: t.reviewed_at?.toISOString() ?? null,
    locked,
  };
}

function driverRow(
  driver: { id: string; username: string; name: string | null; branch: { name: string } | null },
  date: string,
  trips: ReviewTrip[],
  state: DayReviewState,
) {
  return {
    driver_id: driver.id,
    username: driver.username,
    name: driver.name,
    branch: driver.branch?.name ?? null,
    date,
    state,
    deadline: reviewDeadline(trips)?.toISOString() ?? null,
    count: trips.filter((t) => !t.denied_at).length,
    denied: trips.filter((t) => t.denied_at).length,
    trips: trips.map((t) => tripJson(t, tripLocked(t, state))),
  };
}

/**
 * One working day of deliveries, every driver, with each one's receipt photos
 * - what the owner looks at beside the cash count for that shift. Plus the
 * days still waiting on him, so he can find them without paging.
 */
export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const now = new Date();
  const today = todayInBeirut(now);
  const date = url.searchParams.get('date') ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError('INVALID_INPUT', 'date must be YYYY-MM-DD', 400);

  let pendingFrom = today;
  for (let i = 1; i < PENDING_DAYS; i++) pendingFrom = previousBeirutDate(pendingFrom);
  const fromDate = date < pendingFrom ? date : pendingFrom;
  // Through tomorrow: a second shift on one date is filed under the next one
  // by the collision rule, and its trips should be waiting here today, not
  // appear tomorrow.
  const tomorrow = nextBeirutDate(today);
  const toDate = date > tomorrow ? date : tomorrow;
  const { byDriver, drivers } = await loadReviewWindow(prisma, { fromDate, toDate });

  const pending = new Map<string, number>();
  const rows: Array<ReturnType<typeof driverRow>> = [];
  for (const [driverId, days] of byDriver) {
    const driver = drivers.get(driverId);
    if (!driver) continue;
    for (const [d, trips] of days) {
      const state = dayReviewState({ date: d, trips, now });
      if (state === 'open' && d >= pendingFrom) pending.set(d, (pending.get(d) ?? 0) + 1);
      if (d === date) rows.push(driverRow(driver, d, trips, state));
    }
  }
  rows.sort((a, b) => (a.branch ?? '').localeCompare(b.branch ?? '') || a.username.localeCompare(b.username));

  return NextResponse.json({
    ok: true,
    data: {
      date,
      today,
      drivers: rows,
      pending: [...pending.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, n]) => ({ date: d, drivers: n })),
    },
  });
}

export const dynamic = 'force-dynamic';
