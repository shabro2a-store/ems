import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestPunch,
  seedTestRateChange,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function currentMonth(): string {
  return todayInBeirut(new Date()).slice(0, 7);
}

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postJson<T>(url: string, init: { cookies: string; csrf: string; body?: unknown; method?: string }): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey('itest'),
      'X-CSRF-Token': init.csrf,
      Cookie: init.cookies,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

async function getJson<T>(url: string, init: { cookies: string; csrf: string }): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'GET',
    headers: {
      'X-CSRF-Token': init.csrf,
      Cookie: init.cookies,
    },
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

describe('advances integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('employee requests a small advance: pending count goes to 1', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'adv-emp1', branch_id: branch.id });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date(`${currentMonth()}-01T08:00:00Z`) });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'OUT', at: new Date(`${currentMonth()}-01T20:00:00Z`) });
    await seedTestRateChange({ user_id: user.id, rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });

    const { cookies, csrf } = await loginAs(user.username, 'change-me');
    const r = await postJson<{ ok: boolean; data?: { id: string; status: string }; error?: { code: string } }>(
      '/api/me/advances',
      { cookies, csrf, body: { amountCent: 5000, reason: 'rent' } },
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const summary = await getJson<{ ok: boolean; data: { pending: number; approved_balance_cent: number } }>(
      '/api/me/advances',
      { cookies, csrf },
    );
    expect(summary.body.data.pending).toBe(1);
    expect(summary.body.data.approved_balance_cent).toBe(0);
  });

  it('employee request exceeding accrued earnings returns 409 EXCEEDS_ACCRUED_EARNINGS', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'adv-emp2', branch_id: branch.id });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date(`${currentMonth()}-01T08:00:00Z`) });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'OUT', at: new Date(`${currentMonth()}-01T10:00:00Z`) });
    await seedTestRateChange({ user_id: user.id, rate_cent: 200, effective_from: new Date('2026-01-01T00:00:00Z') });

    const { cookies, csrf } = await loginAs(user.username, 'change-me');
    const r = await postJson<{ ok: boolean; error?: { code: string } }>(
      '/api/me/advances',
      { cookies, csrf, body: { amountCent: 999999 } },
    );
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('EXCEEDS_ACCRUED_EARNINGS');
  });

  it('admin GETs pending list, approves; approved_balance updates', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const employee = await seedTestUser({ username: 'adv-emp3', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'adv-admin3', role: Role.ADMIN });
    await seedTestPunch({ user_id: employee.id, branch_id: branch.id, kind: 'IN', at: new Date(`${currentMonth()}-01T08:00:00Z`) });
    await seedTestPunch({ user_id: employee.id, branch_id: branch.id, kind: 'OUT', at: new Date(`${currentMonth()}-01T20:00:00Z`) });
    await seedTestRateChange({ user_id: employee.id, rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });

    const eSession = await loginAs(employee.username, 'change-me');
    const createRes = await postJson<{ ok: boolean; data?: { id: string } }>(
      '/api/me/advances',
      { cookies: eSession.cookies, csrf: eSession.csrf, body: { amountCent: 5000 } },
    );
    expect(createRes.status).toBe(200);
    const advanceId = createRes.body.data!.id;

    const aSession = await loginAs(admin.username, 'change-me');
    const pendingRes = await getJson<{ ok: boolean; data: { advances: Array<{ id: string }> } }>(
      '/api/admin/advances',
      { cookies: aSession.cookies, csrf: aSession.csrf },
    );
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.data.advances.find((a) => a.id === advanceId)).toBeTruthy();

    const decisionRes = await postJson<{ ok: boolean; data?: { status: string } }>(
      `/api/admin/advances/${advanceId}/decision`,
      { cookies: aSession.cookies, csrf: aSession.csrf, body: { decision: 'APPROVED' } },
    );
    expect(decisionRes.status).toBe(200);
    expect(decisionRes.body.data?.status).toBe('APPROVED');

    const summaryRes = await getJson<{ ok: boolean; data: { pending: number; approved_balance_cent: number } }>(
      '/api/me/advances',
      { cookies: eSession.cookies, csrf: eSession.csrf },
    );
    expect(summaryRes.body.data.pending).toBe(0);
    expect(summaryRes.body.data.approved_balance_cent).toBe(5000);

    const audit = await getTestPrisma().auditLog.findMany({
      where: { entity: 'Advance', entity_id: advanceId },
      orderBy: { at: 'asc' },
    });
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('advance.create');
    expect(actions).toContain('advance.approve');
  });

  it('rate limit triggers on 6th advance POST in 1 minute', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'adv-emp-rl', branch_id: branch.id });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date(`${currentMonth()}-01T08:00:00Z`) });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'OUT', at: new Date(`${currentMonth()}-02T08:00:00Z`) });
    await seedTestRateChange({ user_id: user.id, rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });

    const { cookies, csrf } = await loginAs(user.username, 'change-me');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${BASE_URL}/api/me/advances`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey('itest-rl'),
          'X-CSRF-Token': csrf,
          Cookie: cookies,
        },
        body: JSON.stringify({ amountCent: 100 + i }),
      });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});