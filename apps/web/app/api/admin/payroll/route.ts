import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { payoutForUser, payrollRoster } from '@/lib/services/payout';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const month = url.searchParams.get('month');
  if (!month || !MONTH_RE.test(month)) {
    return jsonError('INVALID_INPUT', 'month query param must be YYYY-MM', 400);
  }
  const branchParam = url.searchParams.get('branchId');
  const branchId = branchParam && branchParam !== 'all' ? branchParam : null;

  // Current staff PLUS anyone who started a shift in this month, however they
  // have since left. Filtering on is_active alone made a month you still owed
  // somebody for go blank the moment you deactivated them.
  const [users, branches] = await Promise.all([
    payrollRoster(prisma, month, branchId),
    prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);

  const rows = await Promise.all(
    users.map(async (u) => {
      const r = await payoutForUser(u.id, month, prisma);
      return {
        user_id: u.id,
        // A retired account has had its username parked to free the original,
        // so `name` is what reads as a person in the months they worked.
        username: u.name ?? u.username,
        retired: u.deleted_at !== null,
        role: u.role,
        branch_id: u.branch_id,
        branch_name: u.branch?.name ?? null,
        rate_cent: u.hourly_rate_cent,
        // Reference only — what the owner expects to pay this person. Deliberately
        // excluded from `totals` below: it must never be summed or compared, only
        // displayed next to what they actually earned.
        expected_salary_cent: u.expected_monthly_salary_cent,
        hours: r.hours,
        gross_cent: r.grossCent,
        // Inside gross_cent, not added to it. Without the line the table reads
        // as if they clocked hours they did not.
        blocked_credit_cent: r.blockedCreditCent,
        blocked_credit_min: r.blockedCreditMin,
        adjustments_cent: r.adjustmentsCent,
        advances_cent: r.advancesCent,
        penalties_cent: r.penaltiesCent,
        // netCent subtracts this too. Leaving it out of the response made the
        // table stop adding up, with nothing on screen to explain the gap.
        overtime_deduction_cent: r.overtimeDeductionCent,
        net_cent: r.netCent,
      };
    }),
  );

  const totals = rows.reduce(
    (s, r) => ({
      hours: s.hours + r.hours,
      gross_cent: s.gross_cent + r.gross_cent,
      blocked_credit_cent: s.blocked_credit_cent + r.blocked_credit_cent,
      adjustments_cent: s.adjustments_cent + r.adjustments_cent,
      advances_cent: s.advances_cent + r.advances_cent,
      penalties_cent: s.penalties_cent + r.penalties_cent,
      overtime_deduction_cent: s.overtime_deduction_cent + r.overtime_deduction_cent,
      net_cent: s.net_cent + r.net_cent,
    }),
    {
      hours: 0,
      gross_cent: 0,
      blocked_credit_cent: 0,
      adjustments_cent: 0,
      advances_cent: 0,
      penalties_cent: 0,
      overtime_deduction_cent: 0,
      net_cent: 0,
    },
  );

  return NextResponse.json({ ok: true, data: { rows, totals, month, branchId: branchId ?? 'all', branches } });
}

export const dynamic = 'force-dynamic';
