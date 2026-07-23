import { cookies } from 'next/headers';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from './constants';

export function setAuthCookies(accessToken: string, refreshToken: string, csrfToken: string): void {
  const store = cookies();
  // Cookies are Secure only when the app is actually served over HTTPS.
  // Detection order:
  //   1. PUBLIC_APP_URL starts with https:// — production behind a TLS proxy.
  //   2. forwarded-proto header is https — same thing, alternative source.
  //   3. NODE_ENV === 'production' AND no PUBLIC_APP_URL — legacy fallback.
  //   4. Otherwise (local dev over http://localhost): NOT secure.
  const appUrl = process.env.PUBLIC_APP_URL ?? '';
  const forwardedProto = (store as unknown as { get?: (k: string) => unknown }).get?.('x-forwarded-proto');
  const isHttps =
    appUrl.startsWith('https://') ||
    forwardedProto === 'https' ||
    (process.env.NODE_ENV === 'production' && !appUrl.startsWith('http://'));
  const baseAttrs = {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax' as const,
    path: '/',
  };
  store.set(ACCESS_COOKIE_NAME, accessToken, { ...baseAttrs, maxAge: 60 * 60 * 8 });
  store.set(REFRESH_COOKIE_NAME, refreshToken, { ...baseAttrs, maxAge: 60 * 60 * 24 * 7 });
  store.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
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