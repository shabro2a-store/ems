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
  const rawHeader = req.headers.get('x-csrf-token') ?? undefined;
  // Next.js serializes cookie values with encodeURIComponent, so the csrf cookie
  // is URL-encoded on the wire (e.g. base64 "+/=" become "%2B%2F%3D"). Clients
  // read it via document.cookie and send it back in the X-CSRF-Token header in
  // whatever form they read it (usually still-encoded). Normalize BOTH sides by
  // decoding: a base64 token contains no "%" sequences, so decoding an already
  // decoded value is a no-op, while an encoded value collapses to the original.
  const decode = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return validateCsrf(decode(rawCookie), decode(rawHeader));
}