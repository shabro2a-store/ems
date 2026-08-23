import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { blockedCreditForUser } from '@/lib/services/blockedCredit';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Every blocked-time credit for one employee in a month, decided or not.
//
// The attention queue only reaches back seven days and only shows undecided
// days, which left two holes with no surface at all: a credit nobody ruled on
// within a week was withheld forever, and an accepted credit that went stale -
// this owner corrects punches by hand routinely - silently dropped out of a
// past month's gross with nothing to prompt him. Penalties and overtime both
// have a month-scoped modal on the payroll page for exactly this; credit is the
// first place where staleness moves money AWAY from the employee, so it needs
// one more than either of them.
export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const month = url.searchParams.get('month');
  if (!userId) return jsonError('INVALID_INPUT', 'userId is required', 400);
  if (!month || !MONTH_RE.test(month)) return jsonError('INVALID_INPUT', 'month must be YYYY-MM', 400);

  const items = await blockedCreditForUser(userId, month, prisma);
  return NextResponse.json({
    ok: true,
    data: {
      credits: items.map((c) => ({
        date: c.date,
        blocked_at: c.blockedAt.toISOString(),
        credit_from_at: c.creditFromAt.toISOString(),
        clocked_in_at: c.clockedInAt.toISOString(),
        waitedMin: c.waitedMin,
        creditedMin: c.creditedMin,
        amount_cent: c.amount_cent,
        decision: c.decision,
      })),
    },
  });
}

export const dynamic = 'force-dynamic';
