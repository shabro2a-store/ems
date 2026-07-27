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

  const result = await payoutForUser(userId, month, prisma);
  return NextResponse.json({
    ok: true,
    data: {
      hours: result.hours,
      gross_cent: result.grossCent,
      adjustments_cent: result.adjustmentsCent,
      advances_cent: result.advancesCent,
      penalties_cent: result.penaltiesCent,
      net_cent: result.netCent,
    },
  });
}

export const dynamic = 'force-dynamic';