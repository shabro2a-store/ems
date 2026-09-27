import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * Security #16: every route took "who is asking" from x-user-* headers the
 * middleware set, so anything that got a request past the middleware (the
 * CVE fixed in #1 did exactly that) was believed. And the middleware cannot
 * read the database, so an ended session - reset, retired, signed out
 * elsewhere - kept working until its access token ran out. Routes now read
 * the signed cookie themselves and check the session is still live.
 */
describe('a session that has been ended', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('is refused on its very next request, not when its token runs out', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'ended-emp', branch_id: branch.id });
    const s = await loginAs('ended-emp', 'test-pass-1');
    expect((await fetch(`${BASE_URL}/api/me/today`, { headers: { Cookie: s.cookies } })).status).toBe(200);

    await getTestPrisma().user.update({ where: { id: emp.id }, data: { session_version: { increment: 1 } } });

    expect((await fetch(`${BASE_URL}/api/me/today`, { headers: { Cookie: s.cookies } })).status).toBe(401);
  });

  it('is told to sign in again on an admin route, not that it is not an admin', async () => {
    const admin = await seedTestUser({ username: 'ended-admin', role: Role.ADMIN });
    const s = await loginAs('ended-admin', 'test-pass-1');
    await getTestPrisma().user.update({ where: { id: admin.id }, data: { session_version: { increment: 1 } } });

    expect((await fetch(`${BASE_URL}/api/admin/users`, { headers: { Cookie: s.cookies } })).status).toBe(401);
  });

  /*
   * Found alongside #16: refresh, resume and logout looked for their cookie
   * with `new RegExp(\`(?:^|;\s*)...\`)` - and in a template string `\s` is
   * just `s`. So the cookie was found only when it came FIRST in the header;
   * a browser that sent csrf first was signed out instead of renewed.
   */
  it('renews whatever order the browser sends the cookies in', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'cookie-order', branch_id: branch.id });
    const s = await loginAs('cookie-order', 'test-pass-1');
    const refreshToken = s.cookies.split('; ').find((c) => c.startsWith('ems_refresh='))!;
    const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `csrf=c; theme=dark; ${refreshToken}`, 'X-CSRF-Token': 'c' },
    });
    expect(res.status).toBe(200);
  });

  it('is sent to the login form from an app page', async () => {
    const admin = await seedTestUser({ username: 'ended-page', role: Role.ADMIN });
    const s = await loginAs('ended-page', 'test-pass-1');
    await getTestPrisma().user.update({ where: { id: admin.id }, data: { is_active: false } });

    const res = await fetch(`${BASE_URL}/admin`, { headers: { Cookie: s.cookies }, redirect: 'manual' });
    expect([302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get('location') ?? '').toContain('/login');
  });
});
