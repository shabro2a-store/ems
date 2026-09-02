import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { isMonthOpen, CLOSED_MONTH_MESSAGE } from '@/lib/services/periodLock';
import { penaltyMinForDay } from '@/lib/services/penalty';

// The regex only checks shape. Round-tripping through a UTC Date catches a
// string that is shaped like a date but names no real calendar day (e.g.
// 2026-02-30 silently rolls over to 2026-03-02; 2026-13-01 parses to
// Invalid Date) - either would otherwise reach Prisma unguarded.
function isValidCalendarDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const Body = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCalendarDate, 'date must be a real calendar day'),
  kind: z.enum(['SHORTFALL']),
  // The docked minutes the screen actually rendered. A comparison token only:
  // it is never stored and never becomes money. The stored figure is always
  // the server's own, and the two must agree or the ruling is refused -
  // otherwise a punch corrected while the screen sits open turns a click on a
  // $2.00 row into a ruling on $9.00.
  penaltyMin: z
    .number()
    .int()
    // Not min(0). penaltyMinForDay answers 0 for a day with no penalty - inside
    // the grace, still open, or the current shift-day - so a body of 0 would
    // match and land a ruling on a day no screen ever rendered: on ack that
    // deletes a waiver, on waive it stamps a forgiveness of nothing that then
    // covers whatever the day later grows into. Overtime tolerates the same
    // shape only because a zero ruling there is inert.
    .min(1, 'penaltyMin must name a real penalty: a day with nothing docked cannot be ruled on'),
});

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Let an auto-computed penalty stand. This deliberately changes no money — it
// only clears the notice from the attention queue. Revoking is the other
// endpoint (penalties/waive), which is the one that refunds the employee.
// The ack records the minutes it was given against, so a punch corrected
// later cannot leave a larger penalty upheld by a ruling that never saw it.
export async function POST(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  // A ruling on a settled month would move money that has already been paid.
  // The day itself can still be corrected on the punches screen - what is
  // frozen is the owner's judgement on top of the record, not the record.
  if (!isMonthOpen(body.date)) {
    return jsonError('MONTH_CLOSED', CLOSED_MONTH_MESSAGE, 409);
  }

  const date = new Date(`${body.date}T00:00:00.000Z`);

  // Always the server's own figure - the request cannot name what gets stored.
  // The client's number above only decides whether the ruling may land at all.
  const penaltyMin = await penaltyMinForDay(body.userId, body.date, body.kind, prisma);
  if (body.penaltyMin !== penaltyMin) {
    return jsonError(
      'PENALTY_CHANGED',
      `This day's penalty changed from ${formatMinutes(body.penaltyMin)} to ${formatMinutes(penaltyMin)} while the screen was open. Nothing was changed - check the new figure and decide again.`,
      409,
    );
  }

  const key = { user_id_date_kind: { user_id: body.userId, date, kind: body.kind } };

  // One transaction, because this is the only path here that destroys a row.
  // A failure between the delete and the ack would leave the waiver gone, the
  // deduction started, and nothing on record saying why.
  const clearedWaiver = await prisma.$transaction(async (tx) => {
    // Read before deleting. "This penalty stands" is the exact opposite of
    // "this penalty is removed", and a waiver row is what stops the money
    // whatever figure it names - so an ack has to clear it or it changes
    // nothing at all. But the owner's stated reason for forgiving that day is
    // his record, and deleting it unrecorded makes it unrecoverable.
    const priorWaiver = await tx.penaltyWaiver.findUnique({ where: key });
    const priorAck = await tx.penaltyAck.findUnique({ where: key });
    if (priorWaiver) {
      await tx.penaltyWaiver.delete({ where: key });
    }

    await tx.penaltyAck.upsert({
      where: key,
      create: { user_id: body.userId, date, kind: body.kind, penalty_min: penaltyMin, acknowledged_by: adminId },
      update: { penalty_min: penaltyMin, acknowledged_by: adminId },
    });

    await writeAuditLog({
      db: tx,
      actorId: adminId,
      action: 'penalty.acknowledge',
      entity: 'PenaltyAck',
      entityId: `${body.userId}:${body.date}:${body.kind}`,
      before: {
        waiver: priorWaiver
          ? {
              penalty_min: priorWaiver.penalty_min,
              reason: priorWaiver.reason,
              waived_by: priorWaiver.waived_by,
              created_at: priorWaiver.created_at.toISOString(),
            }
          : null,
        ack: priorAck ? { penalty_min: priorAck.penalty_min, acknowledged_by: priorAck.acknowledged_by } : null,
      },
      after: {
        user_id: body.userId,
        date: body.date,
        kind: body.kind,
        penalty_min: penaltyMin,
        cleared_waiver: priorWaiver !== null,
      },
    });

    return priorWaiver !== null;
  });

  return NextResponse.json({ ok: true, data: { acknowledged: true, cleared_waiver: clearedWaiver } });
}

export const dynamic = 'force-dynamic';
