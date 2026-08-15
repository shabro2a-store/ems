import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

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
  kind: z.enum(['LATE', 'EARLY_LEAVE']),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Let an auto-computed penalty stand. This deliberately changes no money — it
// only clears the notice from the attention queue. Revoking is the other
// endpoint (penalties/waive), which is the one that refunds the employee.
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
  await prisma.penaltyAck.upsert({
    where: { user_id_date_kind: { user_id: body.userId, date, kind: body.kind } },
    create: { user_id: body.userId, date, kind: body.kind, acknowledged_by: adminId },
    update: { acknowledged_by: adminId },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'penalty.acknowledge',
    entity: 'PenaltyAck',
    entityId: `${body.userId}:${body.date}:${body.kind}`,
    after: { user_id: body.userId, date: body.date, kind: body.kind },
  });

  return NextResponse.json({ ok: true, data: { acknowledged: true } });
}

export const dynamic = 'force-dynamic';
