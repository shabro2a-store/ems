import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs, type LoginSession } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * Security #1: the refresh token (7 days) was accepted as an access token, and
 * nothing a session did could be taken back - not signing out, not a password
 * reset, not retiring the person. Security #2: login attempts were counted per
 * username AND per client-supplied IP, so changing X-Forwarded-For on every try
 * made the limit disappear.
 */

function cookie(session: LoginSession, name: string): string {
  return session.cookies.split('; ').find((c) => c.startsWith(`${name}=`))!.slice(name.length + 1);
}

async function refresh(refreshToken: string) {
  return fetch(`${BASE_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: `ems_refresh=${refreshToken}; csrf=c`, 'X-CSRF-Token': 'c' },
  });
}

async function post(session: LoginSession, path: string, body: unknown = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': `auth-${Date.now()}-${Math.random()}`,
    },
    body: JSON.stringify(body),
  });
}

describe('sessions', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('does not accept the refresh token as an access token', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'sess-swap', branch_id: branch.id });
    const s = await loginAs('sess-swap', 'change-me');
    const res = await fetch(`${BASE_URL}/api/me/today`, {
      headers: { Cookie: `ems_access=${cookie(s, 'ems_refresh')}` },
    });
    expect(res.status).toBe(401);
  });

  it('still refreshes a live session', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'sess-live', branch_id: branch.id });
    const s = await loginAs('sess-live', 'change-me');
    expect((await refresh(cookie(s, 'ems_refresh'))).status).toBe(200);
  });

  it('signing out ends the refresh token too, not just the cookies on that phone', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'sess-out', branch_id: branch.id });
    const s = await loginAs('sess-out', 'change-me');
    const kept = cookie(s, 'ems_refresh');
    expect((await post(s, '/api/auth/logout')).status).toBe(200);
    expect((await refresh(kept)).status).toBe(401);
  });

  it('a password reset by the owner ends the sessions already open', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'sess-reset', branch_id: branch.id });
    await seedTestUser({ username: 'sess-admin', role: Role.ADMIN });
    const s = await loginAs('sess-reset', 'change-me');
    const admin = await loginAs('sess-admin', 'change-me');
    expect((await post(admin, `/api/admin/users/${emp.id}/reset-password`, { password: 'a-new-password' })).status).toBe(200);
    expect((await refresh(cookie(s, 'ems_refresh'))).status).toBe(401);
  });

  it('a change of role ends the sessions already open', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'sess-role', branch_id: branch.id });
    await seedTestUser({ username: 'sess-admin2', role: Role.ADMIN });
    const s = await loginAs('sess-role', 'change-me');
    const admin = await loginAs('sess-admin2', 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/users/${emp.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: admin.cookies,
        'X-CSRF-Token': admin.csrf,
        'Idempotency-Key': `role-${Date.now()}`,
      },
      body: JSON.stringify({ role: 'DRIVER' }),
    });
    expect(res.status).toBe(200);
    expect((await refresh(cookie(s, 'ems_refresh'))).status).toBe(401);
  });
});

describe('deactivation', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('ends open sessions, and reactivating does not bring them back', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'sess-deact', branch_id: branch.id });
    await seedTestUser({ username: 'sess-admin3', role: Role.ADMIN });
    const s = await loginAs('sess-deact', 'change-me');
    const admin = await loginAs('sess-admin3', 'change-me');
    const kept = cookie(s, 'ems_refresh');
    expect((await post(admin, `/api/admin/users/${emp.id}/deactivate`)).status).toBe(200);
    expect((await refresh(kept)).status).toBe(401);
    expect((await post(admin, `/api/admin/users/${emp.id}/deactivate`)).status).toBe(200);
    expect((await refresh(kept)).status).toBe(401);
  });
});

describe('login attempts', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  async function attempt(username: string, password: string, ip: string) {
    return fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, 'x-real-ip': ip },
      body: JSON.stringify({ username, password }),
    });
  }

  it('are limited per account, whatever address each one claims to come from', async () => {
    await seedTestUser({ username: 'brute-target', role: Role.ADMIN });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt('brute-target', `guess-${i}`, `10.9.${i}.1`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('refuse a new password shorter than 8 characters', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'pw-admin', role: Role.ADMIN });
    const admin = await loginAs('pw-admin', 'change-me');
    const res = await post(admin, '/api/admin/users', {
      username: 'pw-short',
      password: 'abc123',
      role: 'EMPLOYEE',
      branchId: branch.id,
      hourlyRateCent: 300,
    });
    expect(res.status).toBe(400);
  });
});
