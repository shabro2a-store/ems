import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestUser,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function plusDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function postJson(url: string, init: { cookies: string; csrf: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey('itest-leave'),
      'X-CSRF-Token': init.csrf,
      Cookie: init.cookies,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(url: string, init: { cookies: string; csrf: string }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'GET',
    headers: { 'X-CSRF-Token': init.csrf, Cookie: init.cookies },
  });
  return { status: res.status, body: await res.json() };
}

describe('leave integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('POST /api/me/leave creates LeaveRequest + AuditLog row', async () => {
    const employee = await seedTestUser({ username: 'lv-emp1', branch_id: null });
    const { cookies, csrf } = await loginAs(employee.username, 'change-me');
    const start = plusDays(todayInBeirut(), 7);
    const end = plusDays(todayInBeirut(), 9);

    const r = await postJson('/api/me/leave', {
      cookies, csrf, body: { kind: 'DAY_OFF', start_date: start, end_date: end, note: 'family' },
    });
    expect(r.status).toBe(200);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'LeaveRequest', action: 'leave.create' },
    });
    expect(audit).not.toBeNull();
  });

  it('admin APPROVE creates one ScheduleOverride per date in range + AuditLog', async () => {
    const employee = await seedTestUser({ username: 'lv-emp2', branch_id: null });
    const admin = await seedTestUser({ username: 'lv-admin2', role: Role.ADMIN });
    const { cookies, csrf } = await loginAs(employee.username, 'change-me');
    const start = plusDays(todayInBeirut(), 7);
    const end = plusDays(todayInBeirut(), 9);

    const create = await postJson('/api/me/leave', {
      cookies, csrf, body: { kind: 'DAY_OFF', start_date: start, end_date: end },
    });
    expect(create.status).toBe(200);
    const createBody = create.body as { data?: { id: string } };
    const leaveId = createBody.data!.id;

    const aSession = await loginAs(admin.username, 'change-me');
    const decision = await postJson(`/api/admin/leave/${leaveId}/decision`, {
      cookies: aSession.cookies, csrf: aSession.csrf, body: { decision: 'APPROVED' },
    });
    expect(decision.status).toBe(200);
    const decisionBody = decision.body as { data?: { overrides_created: number } };
    expect(decisionBody.data?.overrides_created).toBe(3);

    const overrides = await getTestPrisma().scheduleOverride.findMany({ where: { user_id: employee.id, source: 'EMPLOYEE_REQUEST' } });
    expect(overrides.length).toBe(3);
    expect(overrides.every((o) => o.kind === 'DAY_OFF')).toBe(true);

    const audit = await getTestPrisma().auditLog.findFirst({ where: { entity: 'LeaveRequest', entity_id: leaveId, action: 'leave.approved' } });
    expect(audit).not.toBeNull();
  });

  it('GET /api/admin/schedules/[userId] includes pendingLeaves', async () => {
    const employee = await seedTestUser({ username: 'lv-emp3', branch_id: null });
    const admin = await seedTestUser({ username: 'lv-admin3', role: Role.ADMIN });
    const { cookies, csrf } = await loginAs(employee.username, 'change-me');
    const start = plusDays(todayInBeirut(), 5);
    const end = plusDays(todayInBeirut(), 5);
    await postJson('/api/me/leave', {
      cookies, csrf, body: { kind: 'TIME_CHANGE', start_date: start, end_date: end },
    });

    const aSession = await loginAs(admin.username, 'change-me');
    const r = await getJson(`/api/admin/schedules/${employee.id}`, { cookies: aSession.cookies, csrf: aSession.csrf });
    expect(r.status).toBe(200);
    const body = r.body as { data?: { pendingLeaves: unknown[] } };
    expect((body.data?.pendingLeaves.length ?? 0)).toBeGreaterThan(0);
  });
});