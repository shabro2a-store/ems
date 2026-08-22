import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';
import { overtimeMinForDay } from '@/lib/services/overtime';

// The regex only checks shape. Round-tripping through a UTC Date catches a
// string that is shaped like a date but names no real calendar day (e.g.
// 2026-02-30 silently rolls over to 2026-03-02; 2026-13-01 parses to
// Invalid Date) - either would otherwise reach Prisma unguarded.
function isValidCalendarDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// PENDING is not an OvertimeDecisionKind - the schema has no such value, and
// deliberately so: the absence of a row IS pending. Accepting it here as a
// decision means "put this day back the way it was", which is the undo the
// owner needs after a mis-clicked Revoke, and it deletes the row.
const Body = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCalendarDate, 'date must be a real calendar day'),
  decision: z.enum(['ACCEPTED', 'REVOKED', 'PENDING']),
  reason: z.string().max(500).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const AUDIT_ACTION = {
  ACCEPTED: 'overtime.accepted',
  REVOKED: 'overtime.revoked',
  PENDING: 'overtime.undecided',
} as const;

// Record the owner's call on one day's overtime. A pending day (no row) is
// already paid - pairHours pays every worked minute - so ACCEPTED changes no
// money and only exists to take the notice off the attention queue; REVOKED is
// what makes payroll subtract that day's excess.
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

  const dateOnly = new Date(`${body.date}T00:00:00.000Z`);

  if (body.decision === 'PENDING') {
    const existing = await prisma.overtimeDecision.findUnique({
      where: { user_id_date: { user_id: body.userId, date: dateOnly } },
    });
    await prisma.overtimeDecision.deleteMany({ where: { user_id: body.userId, date: dateOnly } });
    await writeAuditLog({
      actorId: adminId,
      action: AUDIT_ACTION.PENDING,
      entity: 'OvertimeDecision',
      entityId: `${body.userId}:${body.date}`,
      before: existing
        ? {
            user_id: body.userId,
            date: body.date,
            decision: existing.decision,
            overtime_min: existing.overtime_min,
            reason: existing.reason,
          }
        : null,
      after: { user_id: body.userId, date: body.date, decision: null, reason: body.reason ?? null },
    });
  } else {
    // Stamped server-side, never taken from the request: this is the figure a
    // REVOKED decision deducts against, and a client that could name it could
    // make an old ruling cover work the owner never saw.
    const overtimeMin = await overtimeMinForDay(body.userId, body.date, prisma);

    await prisma.overtimeDecision.upsert({
      where: { user_id_date: { user_id: body.userId, date: dateOnly } },
      create: {
        user_id: body.userId,
        date: dateOnly,
        decision: body.decision,
        overtime_min: overtimeMin,
        reason: body.reason ?? null,
        decided_by: adminId,
      },
      update: {
        decision: body.decision,
        overtime_min: overtimeMin,
        reason: body.reason ?? null,
        decided_by: adminId,
      },
    });

    await writeAuditLog({
      actorId: adminId,
      action: AUDIT_ACTION[body.decision],
      entity: 'OvertimeDecision',
      entityId: `${body.userId}:${body.date}`,
      after: {
        user_id: body.userId,
        date: body.date,
        decision: body.decision,
        overtime_min: overtimeMin,
        reason: body.reason ?? null,
      },
    });
  }

  const response = { ok: true, data: { decision: body.decision } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
