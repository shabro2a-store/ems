import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { renewFromRefreshToken } from '@/lib/auth/issueSession';
import { REFRESH_COOKIE_NAME } from '@/lib/auth/constants';
import { requestCookie } from '@/lib/auth/requestCookie';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// What the client calls on a 401 (lib/api.ts): the access token lasts minutes,
// and this is how a signed-in person stays signed in.
export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }
  const token = requestCookie(req, REFRESH_COOKIE_NAME);
  if (!token) return jsonError('UNAUTHORIZED', 'No refresh token', 401);
  if (!(await renewFromRefreshToken(prisma, token))) {
    return jsonError('UNAUTHORIZED', 'Session ended', 401);
  }
  return NextResponse.json({ ok: true, data: { refreshed: true } });
}
