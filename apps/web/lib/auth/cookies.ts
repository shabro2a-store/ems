import { cookies } from 'next/headers';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from './constants';

// How long the browser keeps the access cookie. The token's own exp is the real
// session length, but a cookie that dies first ends the session early anyway -
// so every caller passes the expiry it signed the token with.
function accessCookieMaxAge(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

// Cookies are Secure only when the app is actually served over HTTPS.
// Detection order:
//   1. PUBLIC_APP_URL starts with https:// — production behind a TLS proxy.
//   2. forwarded-proto header is https — same thing, alternative source.
//   3. NODE_ENV === 'production' AND no PUBLIC_APP_URL — legacy fallback.
//   4. Otherwise (local dev over http://localhost): NOT secure.
function serveOverHttps(): boolean {
  const store = cookies();
  const appUrl = process.env.PUBLIC_APP_URL ?? '';
  const forwardedProto = (store as unknown as { get?: (k: string) => unknown }).get?.('x-forwarded-proto');
  return (
    appUrl.startsWith('https://') ||
    forwardedProto === 'https' ||
    (process.env.NODE_ENV === 'production' && !appUrl.startsWith('http://'))
  );
}

export function setAuthCookies(
  accessToken: string,
  refreshToken: string,
  csrfToken: string,
  accessExpiresAt: Date,
): void {
  const store = cookies();
  const isHttps = serveOverHttps();
  const baseAttrs = {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax' as const,
    path: '/',
  };
  store.set(ACCESS_COOKIE_NAME, accessToken, { ...baseAttrs, maxAge: accessCookieMaxAge(accessExpiresAt) });
  store.set(REFRESH_COOKIE_NAME, refreshToken, { ...baseAttrs, maxAge: 60 * 60 * 24 * 7 });
  store.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

/**
 * Replace only the access cookie, keeping the refresh and CSRF cookies as they
 * are. Used when the session length changes mid-session - a driver punching in
 * or out - where rotating the CSRF token would be churn with no benefit.
 */
export function setAccessCookie(accessToken: string, expiresAt: Date): void {
  cookies().set(ACCESS_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: serveOverHttps(),
    sameSite: 'lax',
    path: '/',
    maxAge: accessCookieMaxAge(expiresAt),
  });
}

export function clearAuthCookies(): void {
  const store = cookies();
  for (const name of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
    store.set(name, '', { path: '/', maxAge: 0 });
  }
}

export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}