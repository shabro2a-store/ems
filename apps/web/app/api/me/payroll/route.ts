import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { payoutForUser } from '@/lib/services/payout';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
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

  const result = await payoutForUser(userId, month, prisma);
  return NextResponse.json({
    ok: true,
    data: {
      hours: result.hours,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        kind: a.kind,
        amount_cent: a.amount_cent,
        reason: a.reason,
        created_at: a.created_at.toISOString(),
      })),
      gross_cent: result.grossCent,
      // Part of gross_cent and of hours, so it needs a line of its own too -
      // otherwise the payslip credits them for hours they know they did not
      // clock, with nothing accounting for it.
      blocked_credit_cent: result.blockedCreditCent,
      blocked_credit_min: result.blockedCreditMin,
      adjustments_cent: result.adjustmentsCent,
      advances_cent: result.advancesCent,
      penalties_cent: result.penaltiesCent,
      // Part of net_cent, so it needs a line of its own - otherwise take-home
      // drops with nothing on the payslip accounting for it.
      overtime_deduction_cent: result.overtimeDeductionCent,
      // A driver's second earnings line; zero for everybody else.
      trips_count: result.tripsCount,
      trips_cent: result.tripsCent,
      trips_denied: result.tripsDenied,
      net_cent: result.netCent,
    },
  });
}

export const dynamic = 'force-dynamic';