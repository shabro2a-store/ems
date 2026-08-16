import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentOpenIn } from '@/lib/services/punch';
import { payoutForUser } from '@/lib/services/payout';
import { todayInBeirut } from 'time';

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const month = todayInBeirut().slice(0, 7);
  const [open, payout] = await Promise.all([
    currentOpenIn(userId),
    payoutForUser(userId, month, prisma),
  ]);

  return NextResponse.json({
    ok: true,
    data: {
      in_at: open ? open.in_at.toISOString() : null,
      minutes_since_in: open ? open.minutes_since_in : null,
      hours_month: payout.hours,
    },
  });
}

export const dynamic = 'force-dynamic';
