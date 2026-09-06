import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { shiftDateOf } from 'time';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';
import { isMonthOpen, CLOSED_MONTH_MESSAGE } from '@/lib/services/periodLock';

const Body = z.object({
  punchId: z.string().min(1),
  reason: z.string().min(1).max(500),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Throw away a checkout the system wrote, and put the shift back.
 *
 * The auto-close cannot tell a double cover from a forgotten punch - both are
 * an arrival with no departure, and the only thing that could separate them is
 * the employee's own OUT punch, which has not arrived yet. So after 20 hours it
 * guesses "forgotten", pays the shift, and tells the owner. This is the owner
 * saying the guess was wrong.
 *
 * It does three things, and all three are needed:
 *
 *  - deletes the system checkout, so the hours go back to being unknown rather
 *    than being the scheduled shift;
 *  - marks the ARRIVAL revoked, so neither the ten-minute sweep nor the
 *    clock-out path may guess again - without this the next tick simply writes
 *    the row back;
 *  - leaves the session OPEN, so the employee's own punch-out is what finally
 *    closes it, at the hour they actually left.
 *
 * Deleting rather than flagging is deliberate. Every reader of "is this session
 * open" asks for an OUT after the IN; a checkout left in place but marked would
 * have to be filtered by every one of them, and the one that got missed would
 * keep the employee locked out.
 */
export async function POST(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) return jsonError('INVALID_INPUT', 'Idempotency-Key header is required', 400);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const out = await prisma.punch.findUnique({
    where: { id: body.punchId },
    select: {
      id: true,
      user_id: true,
      kind: true,
      at: true,
      system_generated: true,
      user: { select: { branch: { select: { day_start_hour: true } } } },
    },
  });
  if (!out) return jsonError('NOT_FOUND', 'Punch not found', 404);
  if (out.kind !== 'OUT' || !out.system_generated) {
    // A punch somebody actually made is theirs. Correcting it is the admin
    // route for that, and it keeps the row and the reason; this one deletes.
    return jsonError('INVALID_INPUT', 'Only a system-written checkout can be revoked', 400);
  }

  // The arrival this checkout closed: the last IN before it. Found by time
  // rather than stored, because that is how every other reader pairs them, and
  // a second definition of "which arrival" is a second thing to get wrong.
  const arrival = await prisma.punch.findFirst({
    where: { user_id: out.user_id, kind: 'IN', at: { lt: out.at } },
    orderBy: { at: 'desc' },
    select: { id: true, at: true },
  });
  if (!arrival) return jsonError('NOT_FOUND', 'No check-in found for this checkout', 404);

  // The month the shift belongs to, by the working day it STARTED - the same
  // rule payroll pays it under. Reopening a shift changes the hours, so it may
  // only happen while that month can still be recalculated.
  const dayStartHour = out.user.branch?.day_start_hour ?? 0;
  const shiftDate = shiftDateOf(arrival.at, dayStartHour);
  if (!isMonthOpen(shiftDate)) {
    return jsonError('MONTH_CLOSED', CLOSED_MONTH_MESSAGE, 409);
  }

  const revokedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.punch.delete({ where: { id: out.id } });
    await tx.punch.update({
      where: { id: arrival.id },
      data: { auto_close_revoked_at: revokedAt },
    });
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'punch.revoke_auto_close',
    entity: 'Punch',
    entityId: out.id,
    before: {
      user_id: out.user_id,
      kind: 'OUT',
      at: out.at.toISOString(),
      system_generated: true,
    },
    after: {
      deleted: true,
      arrival_punch_id: arrival.id,
      arrival_at: arrival.at.toISOString(),
      shift_date: shiftDate,
      auto_close_revoked_at: revokedAt.toISOString(),
      reason: body.reason,
    },
  });

  const response = {
    ok: true as const,
    data: {
      revokedPunchId: out.id,
      arrivalPunchId: arrival.id,
      arrivalAt: arrival.at.toISOString(),
      shiftDate,
    },
  };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response);
}
