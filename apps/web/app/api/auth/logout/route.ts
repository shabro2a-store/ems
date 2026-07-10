import { NextResponse } from 'next/server';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { clearAuthCookies } from '@/lib/auth/cookies';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  if (!csrfFromRequest(req)) {
    return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  }
  clearAuthCookies();
  return NextResponse.json({ ok: true, data: { loggedOut: true } });
}