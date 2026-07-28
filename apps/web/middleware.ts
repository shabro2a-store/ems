import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from './lib/auth/jwt';
import { ACCESS_COOKIE_NAME } from './lib/auth/constants';

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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  const requestHeaders = new Headers(request.headers);

  if (token) {
    const payload = await verifyToken(token);
    if (payload) {
      requestHeaders.set('x-user-id', payload.sub);
      requestHeaders.set('x-user-role', payload.role);
      if (payload.branchId) {
        requestHeaders.set('x-user-branch-id', payload.branchId);
      }
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