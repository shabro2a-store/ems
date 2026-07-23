import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { payoutForUser } from '@/lib/services/payout';
import { PayrollDocument } from 'pdf/payroll';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';

const Query = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const parsed = Query.safeParse({ month: url.searchParams.get('month') });
  if (!parsed.success) {
    return jsonError('INVALID_INPUT', 'month query param required as YYYY-MM', 400);
  }
  const month = parsed.data.month;
  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr!, 10);
  const mo = parseInt(monthStr!, 10);
  if (year < 2020 || year > 2100 || mo < 1 || mo > 12) {
    return jsonError('INVALID_INPUT', 'month out of range', 400);
  }

  // Aggregate user rows for this month
  const users = await prisma.user.findMany({
    where: { is_active: true, role: { in: ['EMPLOYEE', 'DRIVER'] } },
    include: { branch: true },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
  });

  const rows = await Promise.all(
    users.map(async (u) => {
      const payout = await payoutForUser(u.id, month, prisma);
      // Pull the most recent rate for the "rate" column.
      const latestRate = await prisma.rateChange.findFirst({
        where: { user_id: u.id, effective_from: { lte: new Date() } },
        orderBy: { effective_from: 'desc' },
        select: { rate_cent: true },
      });
      return {
        username: u.username,
        role: u.role,
        branch_name: u.branch?.name ?? null,
        hours: payout.hours,
        rate_cent: latestRate?.rate_cent ?? 0,
        gross_cent: payout.grossCent,
        adjustments_cent: payout.adjustmentsCent,
        advances_cent: payout.advancesCent,
        net_cent: payout.netCent,
      };
    }),
  );

  const doc = React.createElement(PayrollDocument, {
    month,
    generatedAt: new Date(),
    rows,
  });
  const buffer = await renderToBuffer(doc as React.ReactElement);

  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll-${month}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

export const dynamic = 'force-dynamic';