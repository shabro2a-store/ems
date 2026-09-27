import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { prisma } from '@/lib/db/prisma';
import { payoutForUser } from '@/lib/services/payout';
import { penaltiesForUser } from '@/lib/services/penalty';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const me = await identity();
  if (!me) return unauthorized();
  const userId = me.userId;
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const url = new URL(req.url);
  const month = url.searchParams.get('month');
  if (!month || !MONTH_RE.test(month)) {
    return jsonError('INVALID_INPUT', 'month query param must be YYYY-MM', 400);
  }

  // The month's manual adjustments, each with its reason. A single summed
  // figure is a number the employee cannot argue with or understand; the reason
  // it was given is what makes a deduction explainable rather than arbitrary.
  const [y, m] = month.split('-').map(Number);
  const adjustments = await prisma.adjustment.findMany({
    where: { user_id: userId, period: new Date(Date.UTC(y!, m! - 1, 1)) },
    orderBy: { created_at: 'asc' },
    select: { id: true, kind: true, amount_cent: true, reason: true, created_at: true },
  });

  const [result, penalties] = await Promise.all([payoutForUser(userId, month, prisma), penaltiesForUser(userId, month, prisma)]);
  // The owner's ruling: staff track their hours, advances, penalties and
  // bonuses - not what they earned. So no gross, no trip pay, no take-home and
  // no rate, and not merely hidden on screen: never sent, so the app's own
  // traffic does not carry them either. What they are docked or given stays.
  return NextResponse.json({
    ok: true,
    data: {
      month,
      hours: result.hours,
      // Inside `hours`: time the app refused a check-in for, which the owner
      // accepted. Minutes, not money.
      blocked_credit_min: result.blockedCreditMin,
      trips_count: result.tripsCount,
      trips_denied: result.tripsDenied,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        kind: a.kind,
        amount_cent: a.amount_cent,
        reason: a.reason,
        created_at: a.created_at.toISOString(),
      })),
      adjustments_cent: result.adjustmentsCent,
      // Each day docked, so the total can be traced to the days behind it. A
      // waived day is left out: nothing is taken for it.
      penalties: penalties
        .filter((p) => !p.waived && p.amount_cent > 0)
        .map((p) => ({ date: p.date, shortfall_min: p.shortfallMin, amount_cent: p.amount_cent })),
      penalties_cent: result.penaltiesCent,
      // Overtime the owner did not approve, taken back.
      overtime_deduction_cent: result.overtimeDeductionCent,
      advances_cent: result.advancesCent,
    },
  });
}

export const dynamic = 'force-dynamic';