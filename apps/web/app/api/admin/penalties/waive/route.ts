import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
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
  waived: z.boolean(),
  // The docked minutes the screen actually rendered. A comparison token only:
  // it is never stored and never becomes money. The stored figure is always
  // the server's own, and the two must agree or the ruling is refused -
  // otherwise a punch corrected while the screen sits open turns a click on a
  // $2.00 row into a ruling on $9.00.
  penaltyMin: z
    .number()
    .int()
    // See the ack route: penaltyMinForDay answers 0 for a day that has no
    // penalty at all, so a body of 0 would match and stamp a forgiveness of
    // nothing - which would then sit there covering whatever that day grows
    // into once a punch is corrected.
    .min(1, 'penaltyMin must name a real penalty: a day with nothing docked cannot be ruled on'),
  reason: z.string().max(500).optional(),
});

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Remove ("waive") or re-apply an auto-computed penalty for one (user, day, kind).
// This only ever touches PenaltyWaiver rows — never a manual Adjustment. The
// waiver records the minutes it was given against, so a punch corrected later
// cannot leave a bigger penalty forgiven by a ruling that never saw it.
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

  const date = new Date(`${body.date}T00:00:00.000Z`);
  const key = { user_id_date_kind: { user_id: body.userId, date, kind: body.kind } };

  // Always the server's own figure - the request cannot name what gets stored.
  // Both directions move money against the amount the screen was showing, so
  // both are confirmed first: waiving hands back what the row says, restoring
  // takes back what the row says. A refusal writes nothing and deletes nothing,
  // so an existing waiver keeps suppressing the penalty across it - the check
  // can never be what starts a deduction.
  const penaltyMin = await penaltyMinForDay(body.userId, body.date, body.kind, prisma);
  if (body.penaltyMin !== penaltyMin) {
    return jsonError(
      'PENALTY_CHANGED',
      `This day's penalty changed from ${formatMinutes(body.penaltyMin)} to ${formatMinutes(penaltyMin)} while the screen was open. Nothing was changed - check the new figure and decide again.`,
      409,
    );
  }

  // Both branches move money, so each writes its row and its record together or
  // writes neither. Restoring is the destructive one and gets exactly what the
  // ack route gets: the row is read inside the transaction and its whole
  // contents - the figure, the owner's written reason, who granted it and when
  // - go into `before`, because deleting the reason a day was forgiven with
  // nothing but a boolean makes it unrecoverable.
  const entityId = `${body.userId}:${body.date}:${body.kind}`;
  await prisma.$transaction(async (tx) => {
    if (body.waived) {
      const prior = await tx.penaltyWaiver.findUnique({ where: key });
      await tx.penaltyWaiver.upsert({
        where: key,
        create: {
          user_id: body.userId,
          date,
          kind: body.kind,
          penalty_min: penaltyMin,
          reason: body.reason ?? null,
          waived_by: adminId,
        },
        update: { penalty_min: penaltyMin, reason: body.reason ?? null, waived_by: adminId },
      });
      await writeAuditLog({
        db: tx,
        actorId: adminId,
        action: 'penalty.waive',
        entity: 'PenaltyWaiver',
        entityId,
        before: prior
          ? {
              penalty_min: prior.penalty_min,
              reason: prior.reason,
              waived_by: prior.waived_by,
              created_at: prior.created_at.toISOString(),
            }
          : null,
        after: {
          user_id: body.userId,
          date: body.date,
          kind: body.kind,
          penalty_min: penaltyMin,
          reason: body.reason ?? null,
        },
      });
      return;
    }

    const prior = await tx.penaltyWaiver.findUnique({ where: key });
    if (prior) {
      await tx.penaltyWaiver.delete({ where: key });
    }
    await writeAuditLog({
      db: tx,
      actorId: adminId,
      action: 'penalty.unwaive',
      entity: 'PenaltyWaiver',
      entityId,
      before: prior
        ? {
            user_id: body.userId,
            date: body.date,
            kind: body.kind,
            penalty_min: prior.penalty_min,
            reason: prior.reason,
            waived_by: prior.waived_by,
            created_at: prior.created_at.toISOString(),
          }
        : null,
    });
  });

  return NextResponse.json({ ok: true, data: { waived: body.waived } });
}

export const dynamic = 'force-dynamic';
