import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { penaltiesForUser } from '@/lib/services/penalty';

const MONTH_RE = /^\d{4}-\d{2}$/;

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Computed late / early-leave penalties for one employee in a month, each with
// its waived flag — feeds the admin "remove penalty" UI on the payroll page.
export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const month = url.searchParams.get('month');
  if (!userId) return jsonError('INVALID_INPUT', 'userId is required', 400);
  if (!month || !MONTH_RE.test(month)) return jsonError('INVALID_INPUT', 'month must be YYYY-MM', 400);

  const penalties = await penaltiesForUser(userId, month, prisma);
  return NextResponse.json({ ok: true, data: { penalties } });
}

export const dynamic = 'force-dynamic';
