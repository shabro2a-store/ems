import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyToken } from '@/lib/auth/jwt';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { issueSession } from '@/lib/auth/issueSession';
import { REFRESH_COOKIE_NAME } from '@/lib/auth/constants';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\s*)${REFRESH_COOKIE_NAME}=([^;]+)`));
  const refreshToken = match?.[1];

  if (!refreshToken) {
    return jsonError('UNAUTHORIZED', 'No refresh token', 401);
  }

  const payload = await verifyToken(refreshToken, 'refresh');
  if (!payload) {
    return jsonError('UNAUTHORIZED', 'Invalid refresh token', 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, branch_id: true, session_version: true, is_active: true, deleted_at: true },
  });
  // Every way a session ends - sign-out, a password reset or change, a role
  // change, retirement - moves session_version on, and a refresh token issued
  // before that is refused here. Role and branch come from the row, not the
  // token, so a refresh never hands back what the owner has since taken away.
  if (!user || !user.is_active || user.deleted_at || user.session_version !== payload.sv) {
    return jsonError('UNAUTHORIZED', 'Session ended', 401);
  }

  await issueSession(prisma, user);
  return NextResponse.json({ ok: true, data: { refreshed: true } });
}
