import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { overtimeForUser } from '@/lib/services/overtime';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Every overtime day for one employee in a month, each carrying the owner's
// decision (null means pending, and pending is paid). The attention queue only
// ever shows pending days, so without this a decided day was unreachable and a
// mis-clicked Revoke could only be undone with a direct database write.
export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const month = url.searchParams.get('month');
  if (!userId) return jsonError('INVALID_INPUT', 'userId is required', 400);
  if (!month || !MONTH_RE.test(month)) return jsonError('INVALID_INPUT', 'month must be YYYY-MM', 400);

  const overtime = await overtimeForUser(userId, month, prisma);
  return NextResponse.json({ ok: true, data: { overtime } });
}

export const dynamic = 'force-dynamic';
