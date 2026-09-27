import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { renewFromRefreshToken } from '@/lib/auth/issueSession';
import { clearAuthCookies } from '@/lib/auth/cookies';
import { REFRESH_COOKIE_NAME } from '@/lib/auth/constants';

/**
 * Where the middleware sends a page request whose access token has lapsed but
 * which still carries a refresh token: renew, then carry on to the page. The
 * page layouts decide "signed in" from the access token alone, so without this
 * a person opening the app after a quarter of an hour was sent to the login
 * form with a perfectly good week-long session in hand.
 *
 * A GET because it is a navigation. It only ever renews the requester's own
 * session, and it only redirects within this site.
 */
export async function GET(req: Request) {
  // The page the middleware was asked for, or ?next= when called directly.
  const next = sameSitePath(req.headers.get('x-resume-next') ?? new URL(req.url).searchParams.get('next'));
  const match = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\s*)${REFRESH_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1] || !(await renewFromRefreshToken(prisma, match[1]))) {
    clearAuthCookies();
    return redirect('/login');
  }
  return redirect(next);
}

// A path on this site, or "/". Anything that a browser could read as another
// host - "//x", "/\x", a scheme - or that carries control characters is not one.
function sameSitePath(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) {
    return '/';
  }
  return raw;
}

function redirect(path: string) {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}

export const dynamic = 'force-dynamic';
