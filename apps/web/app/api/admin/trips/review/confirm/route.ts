import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { CLOSED_MONTH_MESSAGE } from '@/lib/services/periodLock';
import { dayReviewState, loadReviewWindow } from '@/lib/services/tripReview';

const Body = z.object({
  driverId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * The owner has looked at one driver's day of receipts and is done with it.
 *
 * Every trip of that day not yet reviewed is marked, and from here nothing on
 * the day can change: the cash was counted, the orders were confirmed, the
 * driver is paid for what stands. A trip made after this - the driver still
 * on shift - opens the day again for that trip alone.
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

  const { byDriver } = await loadReviewWindow(prisma, { fromDate: body.date, toDate: body.date, driverId: body.driverId });
  const trips = byDriver.get(body.driverId)?.get(body.date) ?? [];
  const now = new Date();
  const state = dayReviewState({ date: body.date, trips, now });
  if (state === 'empty') return jsonError('NOT_FOUND', 'No trips on that day', 404);
  if (state === 'month_closed') return jsonError('MONTH_CLOSED', CLOSED_MONTH_MESSAGE, 409);
  if (state === 'expired') {
    return jsonError('REVIEW_LOCKED', 'The 48 hours for reviewing this day have passed. It is paid as it stands.', 409);
  }
  const pending = trips.filter((t) => t.reviewed_at === null).map((t) => t.id);
  if (pending.length > 0) {
    await prisma.trip.updateMany({
      where: { id: { in: pending }, reviewed_at: null },
      data: { reviewed_at: now, reviewed_by: adminId },
    });
    await writeAuditLog({
      actorId: adminId,
      action: 'trip.review_confirm',
      entity: 'User',
      entityId: body.driverId,
      after: {
        working_day: body.date,
        trip_ids: pending,
        denied: trips.filter((t) => t.denied_at).length,
        confirmed_at: now.toISOString(),
      },
    });
  }

  return NextResponse.json({ ok: true, data: { driverId: body.driverId, date: body.date, confirmed: pending.length } });
}

export const dynamic = 'force-dynamic';
