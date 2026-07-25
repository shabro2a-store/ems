import { randomBytes } from 'crypto';
import { CSRF_COOKIE_NAME } from './constants';

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function validateCsrf(cookieValue: string | undefined, headerValue: string | undefined): boolean {
  if (!cookieValue || !headerValue) return false;
  return constantTimeEqual(cookieValue, headerValue);
}

export function csrfFromRequest(req: Request): boolean {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`));
  const rawCookie = cookieMatch?.[1];
  // Cookies are URL-encoded by the browser. The X-CSRF-Token header is typically
  // already decoded by the client JS (decodeURIComponent). Compare them on the
  // decoded form so both sides work.
  let cookieToken: string | undefined;
  try {
    cookieToken = rawCookie ? decodeURIComponent(rawCookie) : undefined;
  } catch {
    cookieToken = rawCookie;
  }
  const headerToken = req.headers.get('x-csrf-token') ?? undefined;
  return validateCsrf(cookieToken, headerToken);
}