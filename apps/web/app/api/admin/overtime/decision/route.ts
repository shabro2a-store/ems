import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
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
  decision: z.enum(['ACCEPTED', 'REVOKED']),
  reason: z.string().max(500).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

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
  await prisma.overtimeDecision.upsert({
    where: { user_id_date: { user_id: body.userId, date: dateOnly } },
    create: {
      user_id: body.userId,
      date: dateOnly,
      decision: body.decision,
      reason: body.reason ?? null,
      decided_by: adminId,
    },
    update: { decision: body.decision, reason: body.reason ?? null, decided_by: adminId },
  });

  await writeAuditLog({
    actorId: adminId,
    action: body.decision === 'ACCEPTED' ? 'overtime.accepted' : 'overtime.revoked',
    entity: 'OvertimeDecision',
    entityId: `${body.userId}:${body.date}`,
    after: { user_id: body.userId, date: body.date, decision: body.decision, reason: body.reason ?? null },
  });

  const response = { ok: true, data: { decision: body.decision } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
