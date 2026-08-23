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
  // The docked minutes the screen actually rendered. A comparison token only:
  // it is never stored and never becomes money. The stored figure is always
  // the server's own, and the two must agree or the ruling is refused -
  // otherwise a punch corrected while the screen sits open turns a click on a
  // $2.00 row into a ruling on $9.00.
  penaltyMin: z.number().int().min(0),
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

  await prisma.penaltyAck.upsert({
    where: { user_id_date_kind: { user_id: body.userId, date, kind: body.kind } },
    create: { user_id: body.userId, date, kind: body.kind, penalty_min: penaltyMin, acknowledged_by: adminId },
    update: { penalty_min: penaltyMin, acknowledged_by: adminId },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'penalty.acknowledge',
    entity: 'PenaltyAck',
    entityId: `${body.userId}:${body.date}:${body.kind}`,
    after: { user_id: body.userId, date: body.date, kind: body.kind, penalty_min: penaltyMin },
  });

  return NextResponse.json({ ok: true, data: { acknowledged: true } });
}

export const dynamic = 'force-dynamic';
