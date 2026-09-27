import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: () => new Headers({ 'x-user-id': 'u1', 'x-user-role': 'EMPLOYEE' }),
  cookies: () => ({ get: () => undefined }),
}));
const queryRaw = vi.fn();
vi.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

import { POST as devPunch } from '@/app/api/me/punch/dev/route';
import { GET as healthDb } from '@/app/api/health/db/route';

afterEach(() => {
  vi.unstubAllEnvs();
  queryRaw.mockReset();
});

/*
 * Security #9: the GPS-bypass punch was guarded by one variable. Set by
 * mistake on the server - it is a line in the same .env - it let anyone clock
 * in from anywhere. A production build now never serves it.
 */
describe('the dev GPS bypass', () => {
  it('does not exist in a production build, whatever the flag says', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_DEV_ENDPOINTS', 'true');
    const res = await devPunch(
      new Request('http://127.0.0.1/api/me/punch/dev', { method: 'POST', body: JSON.stringify({ kind: 'IN' }) }),
    );
    expect(res.status).toBe(404);
  });
});

/*
 * Security #13: the public database health check answered with the driver's
 * raw error - user names, host names, and whatever else Postgres says.
 */
describe('the database health check', () => {
  it('says the database is unreachable without repeating what the database said', async () => {
    queryRaw.mockRejectedValue(new Error('password authentication failed for user "ems" at db:5432'));
    const res = await healthDb();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('DB_UNREACHABLE');
    expect(text).not.toContain('password authentication');
    expect(text).not.toContain('db:5432');
  });
});
