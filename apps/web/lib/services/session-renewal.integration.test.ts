import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs, type LoginSession } from '../test-helpers/auth';
import { ACCESS_TTL_MIN } from '../auth/constants';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #44, server side. The access token now lives minutes and the client renews
 * it; a page opened after it lapsed is renewed on the way in, through
 * /api/auth/resume, instead of bouncing a signed-in person to the login form.
 * An ended session gets the login form - the renewal is where it is refused.
 */
function cookie(session: LoginSession, name: string): string {
  return session.cookies.split('; ').find((c) => c.startsWith(`${name}=`))!.slice(name.length + 1);
}

function setCookies(res: Response): string[] {
  return (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

function ttlMinutes(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number };
  return Math.round((payload.exp - Date.now() / 1000) / 60);
}

describe('session renewal', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('issues an access token that lives minutes, not hours', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'ttl-emp', branch_id: branch.id });
    const s = await loginAs('ttl-emp', 'test-pass-1');
    expect(ttlMinutes(cookie(s, 'ems_access'))).toBe(ACCESS_TTL_MIN);
  });

  it('renews a page opened after the access token lapsed, instead of sending it to the login form', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'resume-page', branch_id: branch.id });
    const s = await loginAs('resume-page', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/employee?tab=pay`, {
      headers: { Cookie: `ems_refresh=${cookie(s, 'ems_refresh')}` },
      redirect: 'manual',
    });
    // Back to the very page asked for, now carrying a fresh access token.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/employee?tab=pay');
    expect(setCookies(res).some((c) => c.startsWith('ems_access=') && !c.startsWith('ems_access=;'))).toBe(true);
  });

  it('sends a page with no session at all to the login form, as before', async () => {
    const res = await fetch(`${BASE_URL}/employee`, { redirect: 'manual' });
    expect(res.headers.get('location')).toMatch(/\/login$/);
  });

  it('renews on the way in and carries on to the page asked for', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'resume-ok', branch_id: branch.id });
    const s = await loginAs('resume-ok', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/api/auth/resume?next=%2Femployee`, {
      headers: { Cookie: `ems_refresh=${cookie(s, 'ems_refresh')}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/employee');
    expect(setCookies(res).some((c) => c.startsWith('ems_access=') && !c.startsWith('ems_access=;'))).toBe(true);
  });

  it('sends an ended session to the login form, with its cookies cleared', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'resume-ended', branch_id: branch.id });
    const s = await loginAs('resume-ended', 'test-pass-1');
    await getTestPrisma().user.update({ where: { id: emp.id }, data: { session_version: { increment: 1 } } });
    const res = await fetch(`${BASE_URL}/api/auth/resume?next=%2Femployee`, {
      headers: { Cookie: `ems_refresh=${cookie(s, 'ems_refresh')}` },
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe('/login');
    expect(setCookies(res).some((c) => c.startsWith('ems_refresh=;') || /^ems_refresh=[^;]*;.*Max-Age=0/i.test(c))).toBe(true);
  });

  it('never sends anyone off the site', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'resume-evil', branch_id: branch.id });
    const s = await loginAs('resume-evil', 'test-pass-1');
    for (const next of ['//evil.example', 'https://evil.example/x', '/\\evil.example']) {
      const res = await fetch(`${BASE_URL}/api/auth/resume?next=${encodeURIComponent(next)}`, {
        headers: { Cookie: `ems_refresh=${cookie(s, 'ems_refresh')}` },
        redirect: 'manual',
      });
      expect(res.headers.get('location')).toBe('/');
    }
  });

  it('gives a driver the same short token as everyone, clocked in or not', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    await seedTestUser({ username: 'resume-driver', role: Role.DRIVER, branch_id: branch.id });
    const s = await loginAs('resume-driver', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `rd-${Date.now()}`,
        'X-CSRF-Token': s.csrf,
        Cookie: s.cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'fp-rd' }),
    });
    expect(res.status).toBe(200);
    // No twelve-hour token handed out at the punch any more: renewal keeps a
    // shift signed in, and a revoked driver stops within minutes.
    expect(setCookies(res).some((c) => c.startsWith('ems_access='))).toBe(false);
  });
});
