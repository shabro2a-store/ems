import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';
import { creditedMinForDay } from '@/lib/services/blockedCredit';

// The regex only checks shape. Round-tripping through a UTC Date catches a
// string that is shaped like a date but names no real calendar day (e.g.
// 2026-02-30 silently rolls over to 2026-03-02; 2026-13-01 parses to
// Invalid Date) - either would otherwise reach Prisma unguarded.
function isValidCalendarDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// PENDING is not a CreditDecisionKind - the absence of a row IS pending, and
// pending credit grants nothing. Accepting it here means "put this day back on
// the queue undecided", the undo for a mis-clicked Accept or Revoke, and it
// deletes the row.
const Body = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCalendarDate, 'date must be a real calendar day'),
  decision: z.enum(['ACCEPTED', 'REVOKED', 'PENDING']),
  // The credit the screen actually rendered. A comparison token only: it is
  // never stored and never becomes money. The stored figure is always the
  // server's own, and the two must agree or the ruling is refused - a punch
  // corrected while the modal sits open moves what the day is owed, and with
  // it the credit, so a click on "$3.00" must not land on $9.00. Not required
  // for PENDING, which only ever hands money back.
  creditedMin: z.number().int().min(0).optional(),
  reason: z.string().max(500).optional(),
});

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const AUDIT_ACTION = {
  ACCEPTED: 'blocked_credit.accepted',
  REVOKED: 'blocked_credit.revoked',
  PENDING: 'blocked_credit.undecided',
} as const;

// Record the owner's call on one day's blocked-time credit. A pending day (no
// row) grants nothing, so this is an approval rather than a review: ACCEPTED is
// what puts the minutes into gross and clears that day's shortfall; REVOKED
// changes no money at all and only takes the notice off the queue. Note the
// inversion against overtime, where the pending day is the paid one.
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
  // Optional in the schema so PENDING need not carry it (it only ever takes
  // money back off the table), mandatory here for a ruling that could move it.
  if (body.decision !== 'PENDING' && body.creditedMin === undefined) {
    return jsonError('INVALID_INPUT', 'creditedMin is required: a decision must name the amount it was made against', 400);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const dateOnly = new Date(`${body.date}T00:00:00.000Z`);

  if (body.decision === 'PENDING') {
    const existing = await prisma.blockedCreditDecision.findUnique({
      where: { user_id_date: { user_id: body.userId, date: dateOnly } },
    });
    await prisma.blockedCreditDecision.deleteMany({ where: { user_id: body.userId, date: dateOnly } });
    await writeAuditLog({
      actorId: adminId,
      action: AUDIT_ACTION.PENDING,
      entity: 'BlockedCreditDecision',
      entityId: `${body.userId}:${body.date}`,
      before: existing
        ? {
            user_id: body.userId,
            date: body.date,
            decision: existing.decision,
            credited_min: existing.credited_min,
            reason: existing.reason,
          }
        : null,
      after: { user_id: body.userId, date: body.date, decision: null, reason: body.reason ?? null },
    });
  } else {
    // Always the server's own figure - the request cannot name what gets
    // stored. The client's number above only decides whether the ruling is
    // allowed to land at all.
    const creditedMin = await creditedMinForDay(body.userId, body.date, prisma);
    if (body.creditedMin !== creditedMin) {
      return jsonError(
        'CREDIT_CHANGED',
        `This day's credited time changed from ${formatMinutes(body.creditedMin!)} to ${formatMinutes(creditedMin)} while the screen was open. Nothing was changed - check the new figure and decide again.`,
        409,
      );
    }
    // creditedMinForDay answers 0 for a day with no credit at all, so a body of
    // 0 would match and stamp a ruling on nothing - which would then sit there
    // covering whatever the day grows into once a punch is corrected.
    if (creditedMin === 0) {
      return jsonError(
        'INVALID_INPUT',
        'This day has no credited time to rule on.',
        400,
      );
    }

    await prisma.blockedCreditDecision.upsert({
      where: { user_id_date: { user_id: body.userId, date: dateOnly } },
      create: {
        user_id: body.userId,
        date: dateOnly,
        decision: body.decision,
        credited_min: creditedMin,
        reason: body.reason ?? null,
        decided_by: adminId,
      },
      update: {
        decision: body.decision,
        credited_min: creditedMin,
        reason: body.reason ?? null,
        decided_by: adminId,
      },
    });

    await writeAuditLog({
      actorId: adminId,
      action: AUDIT_ACTION[body.decision],
      entity: 'BlockedCreditDecision',
      entityId: `${body.userId}:${body.date}`,
      after: {
        user_id: body.userId,
        date: body.date,
        decision: body.decision,
        credited_min: creditedMin,
        reason: body.reason ?? null,
      },
    });
  }

  const response = { ok: true, data: { decision: body.decision } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
