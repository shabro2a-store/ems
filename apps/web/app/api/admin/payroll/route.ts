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
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const month = url.searchParams.get('month');
  if (!month || !MONTH_RE.test(month)) {
    return jsonError('INVALID_INPUT', 'month query param must be YYYY-MM', 400);
  }

  const users = await prisma.user.findMany({
    where: { is_active: true, role: { in: ['EMPLOYEE', 'DRIVER'] } },
    select: { id: true, username: true, branch_id: true },
    orderBy: { username: 'asc' },
  });

  const rows = await Promise.all(
    users.map(async (u) => {
      const r = await payoutForUser(u.id, month, prisma);
      return {
        user_id: u.id,
        username: u.username,
        branch_id: u.branch_id,
        hours: r.hours,
        gross_cent: r.grossCent,
        adjustments_cent: r.adjustmentsCent,
        advances_cent: r.advancesCent,
        net_cent: r.netCent,
      };
    }),
  );

  const totals = rows.reduce(
    (s, r) => ({
      hours: s.hours + r.hours,
      gross_cent: s.gross_cent + r.gross_cent,
      adjustments_cent: s.adjustments_cent + r.adjustments_cent,
      advances_cent: s.advances_cent + r.advances_cent,
      net_cent: s.net_cent + r.net_cent,
    }),
    { hours: 0, gross_cent: 0, adjustments_cent: 0, advances_cent: 0, net_cent: 0 },
  );

  return NextResponse.json({ ok: true, data: { rows, totals, month } });
}

export const dynamic = 'force-dynamic';