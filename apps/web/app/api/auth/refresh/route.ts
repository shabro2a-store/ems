import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyToken, signToken } from '@/lib/auth/jwt';
import { generateCsrfToken, csrfFromRequest } from '@/lib/auth/csrf';
import { sessionExpiryFor, type ScheduleEntry } from '@/lib/auth/session';
import { setAuthCookies } from '@/lib/auth/cookies';
import { REFRESH_COOKIE_NAME } from '@/lib/auth/constants';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE_NAME}=([^;]+)`));
  const refreshToken = match?.[1];

  if (!refreshToken) {
    return jsonError('UNAUTHORIZED', 'No refresh token', 401);
  }

  const payload = await verifyToken(refreshToken);
  if (!payload) {
    return jsonError('UNAUTHORIZED', 'Invalid refresh token', 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { schedules: true },
  });
  if (!user || !user.is_active) {
    return jsonError('UNAUTHORIZED', 'User inactive', 401);
  }

  const now = new Date();
  const schedules: ScheduleEntry[] = user.schedules.map((s) => ({
    weekday: s.weekday,
    start_time: s.start_time,
    end_time: s.end_time,
  }));
  const exp = sessionExpiryFor({ role: user.role }, schedules, now);
  const newAccess = await signToken(
    { sub: user.id, role: user.role, branchId: user.branch_id ?? null },
    exp,
  );
  const refreshExp = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  const newRefresh = await signToken(
    { sub: user.id, role: user.role, branchId: user.branch_id ?? null },
    refreshExp,
  );
  const csrf = generateCsrfToken();
  setAuthCookies(newAccess, newRefresh, csrf);

  return NextResponse.json({ ok: true, data: { refreshed: true } });
}