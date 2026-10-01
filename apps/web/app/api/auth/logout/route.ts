import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { clearAuthCookies } from '@/lib/auth/cookies';
import { writeAuditLog } from '@/lib/services/audit';
import { verifyToken } from '@/lib/auth/jwt';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from '@/lib/auth/constants';
import { requestCookie } from '@/lib/auth/requestCookie';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Sign out, everywhere. Clearing the cookies only ever ended the session on
 * this one phone - a copied refresh token kept working for a week - so the
 * person's session version moves on too, which every token they hold was
 * issued under. Found from whichever token is still valid.
 */
export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }
  const access = requestCookie(req, ACCESS_COOKIE_NAME);
  const refresh = requestCookie(req, REFRESH_COOKIE_NAME);
  const who =
    (access ? await verifyToken(access, 'access') : null) ?? (refresh ? await verifyToken(refresh, 'refresh') : null);
  if (who) {
    await prisma.user.updateMany({
      where: { id: who.sub, session_version: who.sv },
      data: { session_version: { increment: 1 } },
    });
    await writeAuditLog({ actorId: who.sub, action: 'auth.logout', entity: 'User', entityId: who.sub });
  }
  await clearAuthCookies();
  return NextResponse.json({ ok: true, data: { loggedOut: true } });
}
