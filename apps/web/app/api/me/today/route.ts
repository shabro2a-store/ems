import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const open = await currentOpenIn(userId);
  if (!open) {
    return NextResponse.json({
      ok: true,
      data: {
        in_at: null,
        minutes_since_in: null,
        earned_today_cent: 0,
        earned_month_cent: 0,
        approved_advance_balance_cent: 0,
        net_cent: 0,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    data: {
      in_at: open.in_at.toISOString(),
      minutes_since_in: open.minutes_since_in,
      earned_today_cent: 0,
      earned_month_cent: 0,
      approved_advance_balance_cent: 0,
      net_cent: 0,
    },
  });
}

export const dynamic = 'force-dynamic';
