import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { signToken } from '@/lib/auth/jwt';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from '@/lib/auth/constants';

/*
 * The middleware is the first gate on every request, and it was only ever
 * exercised through the live server. These pin its four decisions directly:
 * strip headers a client could forge, turn away /api/me|admin|caller without a
 * valid access token, send a page whose access token lapsed through
 * /api/auth/resume, and leave everything else alone.
 *
 * Next reports what it decided in response headers: x-middleware-rewrite for a
 * rewrite, and x-middleware-request-<name> (listed in
 * x-middleware-override-headers) for each header the request goes on with.
 */
let access: string;
let refresh: string;

beforeAll(async () => {
  process.env.JWT_SECRET ??= 'ci-test-secret-do-not-use-in-prod-0123456789abcdef0123456789abcdef';
  const claims = { sub: 'u1', role: 'EMPLOYEE' as const, branchId: 'b1', sv: 0 };
  access = await signToken(claims, new Date(Date.now() + 600_000), 'access');
  refresh = await signToken(claims, new Date(Date.now() + 600_000), 'refresh');
});

function req(path: string, opts: { access?: string; refresh?: string; headers?: Record<string, string> } = {}) {
  const cookies = [
    opts.access ? `${ACCESS_COOKIE_NAME}=${opts.access}` : '',
    opts.refresh ? `${REFRESH_COOKIE_NAME}=${opts.refresh}` : '',
  ].filter(Boolean);
  return new NextRequest(`http://localhost${path}`, {
    headers: { ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...opts.headers },
  });
}

function forwarded(res: Response): string[] {
  return (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);
}

describe('middleware', () => {
  it('strips x-user-* and x-resume-next a client sent, whoever is signed in', async () => {
    const res = await middleware(
      req('/api/me/ping', {
        access,
        headers: { 'x-user-id': 'someone-else', 'x-user-role': 'ADMIN', 'x-user-branch-id': 'b9', 'x-resume-next': '//evil.example' },
      }),
    );
    expect(res.status).toBe(200);
    for (const h of ['x-user-id', 'x-user-role', 'x-user-branch-id', 'x-resume-next']) {
      expect(forwarded(res)).not.toContain(h);
      expect(res.headers.get(`x-middleware-request-${h}`)).toBeNull();
    }
  });

  it.each(['/api/me/ping', '/api/admin/overview', '/api/caller/drivers'])('turns away %s without an access token', async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  });

  it('does not take a refresh token in the access cookie', async () => {
    const res = await middleware(req('/api/me/ping', { access: refresh }));
    expect(res.status).toBe(401);
  });

  it('answers an API call with a lapsed access token 401, not a resume', async () => {
    const res = await middleware(req('/api/me/ping', { refresh }));
    expect(res.status).toBe(401);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it.each(['/employee?tab=month', '/admin/payroll', '/'])('sends %s through /api/auth/resume when only the refresh token is left', async (path) => {
    const res = await middleware(req(path, { refresh }));
    expect(new URL(res.headers.get('x-middleware-rewrite')!).pathname).toBe('/api/auth/resume');
    expect(res.headers.get('x-middleware-request-x-resume-next')).toBe(path);
  });

  it('leaves a page alone while the access token is good', async () => {
    const res = await middleware(req('/employee', { access, refresh }));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('never resumes the service worker, icons or sounds', async () => {
    const res = await middleware(req('/sw.js', { refresh }));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('lets public API routes through without a token', async () => {
    for (const path of ['/api/health', '/api/auth/login', '/api/telegram/webhook']) {
      expect((await middleware(req(path))).status, path).toBe(200);
    }
  });
});
