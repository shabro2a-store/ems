import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from './lib/auth/jwt';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from './lib/auth/constants';

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/telegram/webhook',
  '/api/health',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// The signed-in parts of the app. Their layouts decide "signed in" from the
// access token alone - and that token lasts minutes - so a page asked for
// after it lapsed goes through /api/auth/resume first. Listed rather than
// "every page", so the service worker, icons and sounds are never redirected.
const APP_SECTIONS = ['/admin', '/employee', '/driver', '/caller'];

function isAppPage(pathname: string): boolean {
  return APP_SECTIONS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  const requestHeaders = new Headers(request.headers);
  const payload = token ? await verifyToken(token, 'access') : null;
  // Only ever set below, for the resume route - never taken from the client.
  requestHeaders.delete('x-resume-next');

  if (!payload && isAppPage(pathname) && request.cookies.get(REFRESH_COOKIE_NAME)?.value) {
    // Handed to the resume route in place, not redirected: a redirect from
    // here must be an absolute URL, and behind the tunnel this process does
    // not reliably know the host and scheme the browser used. The route renews
    // and answers with a relative redirect back to this same page.
    requestHeaders.set('x-resume-next', pathname + search);
    return NextResponse.rewrite(new URL('/api/auth/resume', request.url), { request: { headers: requestHeaders } });
  }

  if (token) {
    if (payload) {
      requestHeaders.set('x-user-id', payload.sub);
      requestHeaders.set('x-user-role', payload.role);
      // Set or removed, never left as the client sent it.
      if (payload.branchId) requestHeaders.set('x-user-branch-id', payload.branchId);
      else requestHeaders.delete('x-user-branch-id');
    } else {
      requestHeaders.delete('x-user-id');
      requestHeaders.delete('x-user-role');
      requestHeaders.delete('x-user-branch-id');
    }
  } else {
    requestHeaders.delete('x-user-id');
    requestHeaders.delete('x-user-role');
    requestHeaders.delete('x-user-branch-id');
  }

  if (
    pathname.startsWith('/api/me/') ||
    pathname.startsWith('/api/admin/') ||
    pathname.startsWith('/api/caller/')
  ) {
    if (isPublic(pathname)) {
      return NextResponse.next({ request: { headers: requestHeaders } });
    }
    const userId = requestHeaders.get('x-user-id');
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 },
      );
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    '/api/((?!_next/static|_next/image|favicon.ico).*)',
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};