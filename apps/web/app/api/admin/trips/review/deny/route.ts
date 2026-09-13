import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { inBeirut, previousBeirutDate, nextBeirutDate } from 'time';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { CLOSED_MONTH_MESSAGE } from '@/lib/services/periodLock';
import { dayReviewState, tripLocked, loadReviewWindow, type ReviewTrip } from '@/lib/services/tripReview';

const Body = z.object({
  tripId: z.string().min(1),
  deny: z.boolean(),
  reason: z.string().max(300).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const REVIEW_EXPIRED_MESSAGE = 'The 48 hours for reviewing this day have passed. It is paid as it stands.';

/**
 * The owner looked at the receipt photo and said no - or took it back.
 *
 * A denied trip pays nothing and is not one of the day's deliveries. Allowed
 * only while the day is still open for review: not once he has confirmed it,
 * not 48 hours after its last trip, and not once the month has closed - each
 * of those has settled what the driver is paid.
 */
export async function POST(req: Request) {
  const h = headers();
  const adminId = h.get('x-user-id');
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const trip = await prisma.trip.findUnique({
    where: { id: body.tripId },
    select: { id: true, driver_id: true, out_at: true, denied_at: true, denied_reason: true, reviewed_at: true },
  });
  if (!trip) return jsonError('NOT_FOUND', 'Trip not found', 404);

  // Which working day the trip is filed under is the punches' call, so the
  // day is read the way the review page reads it: a day either side of the
  // calendar date, then the one that holds this trip.
  const calendar = inBeirut(trip.out_at).date;
  const { byDriver } = await loadReviewWindow(prisma, {
    fromDate: previousBeirutDate(calendar),
    toDate: nextBeirutDate(calendar),
    driverId: trip.driver_id,
  });
  let found: { date: string; trips: ReviewTrip[] } | null = null;
  for (const [date, trips] of byDriver.get(trip.driver_id) ?? []) {
    if (trips.some((t) => t.id === trip.id)) found = { date, trips };
  }
  if (!found) return jsonError('NOT_FOUND', 'Trip not found on any working day', 404);

  const now = new Date();
  const state = dayReviewState({ date: found.date, trips: found.trips, now });
  if (state === 'month_closed') return jsonError('MONTH_CLOSED', CLOSED_MONTH_MESSAGE, 409);
  if (tripLocked(trip, state)) {
    return jsonError(
      'REVIEW_LOCKED',
      state === 'expired' ? REVIEW_EXPIRED_MESSAGE : 'This day has been confirmed. Its trips can no longer change.',
      409,
    );
  }

  const before = { denied_at: trip.denied_at?.toISOString() ?? null, denied_reason: trip.denied_reason };
  const data = body.deny
    ? { denied_at: now, denied_by: adminId, denied_reason: body.reason?.trim() || null }
    : { denied_at: null, denied_by: null, denied_reason: null };
  await prisma.trip.update({ where: { id: trip.id }, data });
  await writeAuditLog({
    actorId: adminId,
    action: body.deny ? 'trip.deny' : 'trip.restore',
    entity: 'Trip',
    entityId: trip.id,
    before,
    after: { ...data, denied_at: data.denied_at?.toISOString() ?? null, working_day: found.date },
  });

  return NextResponse.json({ ok: true, data: { tripId: trip.id, denied: body.deny, date: found.date } });
}

export const dynamic = 'force-dynamic';
