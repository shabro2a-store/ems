import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { renewFromRefreshToken } from '@/lib/auth/issueSession';
import { REFRESH_COOKIE_NAME } from '@/lib/auth/constants';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// What the client calls on a 401 (lib/api.ts): the access token lasts minutes,
// and this is how a signed-in person stays signed in.
export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }
  const match = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\s*)${REFRESH_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) return jsonError('UNAUTHORIZED', 'No refresh token', 401);
  if (!(await renewFromRefreshToken(prisma, match[1]))) {
    return jsonError('UNAUTHORIZED', 'Session ended', 401);
  }
  return NextResponse.json({ ok: true, data: { refreshed: true } });
}
