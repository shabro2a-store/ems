import { cookies } from 'next/headers';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_TTL_DAYS } from './constants';

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
async function serveOverHttps(): Promise<boolean> {
  const store = await cookies();
  const appUrl = process.env.PUBLIC_APP_URL ?? '';
  const forwardedProto = (store as unknown as { get?: (k: string) => unknown }).get?.('x-forwarded-proto');
  return (
    appUrl.startsWith('https://') ||
    forwardedProto === 'https' ||
    (process.env.NODE_ENV === 'production' && !appUrl.startsWith('http://'))
  );
}

export async function setAuthCookies(
  accessToken: string,
  refreshToken: string,
  csrfToken: string,
  accessExpiresAt: Date,
): Promise<void> {
  const store = await cookies();
  const isHttps = await serveOverHttps();
  const baseAttrs = {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax' as const,
    path: '/',
  };
  store.set(ACCESS_COOKIE_NAME, accessToken, { ...baseAttrs, maxAge: accessCookieMaxAge(accessExpiresAt) });
  store.set(REFRESH_COOKIE_NAME, refreshToken, { ...baseAttrs, maxAge: 60 * 60 * 24 * REFRESH_TTL_DAYS });
  store.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * REFRESH_TTL_DAYS,
  });
}

export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  for (const name of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
    store.set(name, '', { path: '/', maxAge: 0 });
  }
}

/**
 * The client's address as Cloudflare saw it, or null when nothing vouches for
 * it. Cloudflare overwrites CF-Connecting-IP on every request it forwards, and
 * the app only listens on loopback behind the tunnel, so a client cannot set
 * it. X-Forwarded-For and X-Real-IP are whatever the client sent - fine as
 * evidence of what a phone claimed, never as the key a limit is counted on.
 */
export function trustedClientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip')?.trim() || null;
}

/** Best-effort address for the record (punch evidence): trusted when possible. */
export function getClientIp(req: Request): string {
  const trusted = trustedClientIp(req);
  if (trusted) return trusted;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}