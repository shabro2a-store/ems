import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestUser, seedTestBranch } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('admin-users integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('POST /api/admin/users creates user + RateChange in same tx', async () => {
    const admin = await seedTestUser({ username: 'u-admin1', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('uc'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({
        username: 'new-emp-1',
        password: 'test-pass-1',
        role: 'EMPLOYEE',
        branchId: branch.id,
        hourlyRateCent: 300,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { user: { id: string }; temp_password: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.temp_password).toBeDefined();

    const rateChanges = await getTestPrisma().rateChange.findMany({ where: { user_id: body.data!.user.id } });
    expect(rateChanges.length).toBe(1);
    expect(rateChanges[0]?.rate_cent).toBe(300);
  });

  it('PATCH /api/admin/users/:id with new rate creates new RateChange row', async () => {
    const admin = await seedTestUser({ username: 'u-admin2', role: Role.ADMIN });
    const employee = await seedTestUser({ username: 'u-emp2', hourly_rate_cent: 200 });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${employee.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('ue'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ hourlyRateCent: 350 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { user: { hourly_rate_cent: number } } };
    expect(body.ok).toBe(true);
    expect(body.data?.user.hourly_rate_cent).toBe(350);

    const rateChanges = await getTestPrisma().rateChange.findMany({
      where: { user_id: employee.id },
      orderBy: { effective_from: 'asc' },
    });
    expect(rateChanges.length).toBe(2);
    expect(rateChanges[0]?.rate_cent).toBe(200);
    expect(rateChanges[1]?.rate_cent).toBe(350);
  });

  it('PATCH /api/admin/users/:id sets and clears expectedMonthlySalaryCent, writing an AuditLog entry', async () => {
    const admin = await seedTestUser({ username: 'u-admin5', role: Role.ADMIN });
    const employee = await seedTestUser({ username: 'u-emp5' });
    const session = await loginAs(admin.username, 'change-me');

    const setRes = await fetch(`${BASE_URL}/api/admin/users/${employee.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('sal'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ expectedMonthlySalaryCent: 75000 }),
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { ok: boolean; data?: { user: { expected_monthly_salary_cent: number | null } } };
    expect(setBody.ok).toBe(true);
    expect(setBody.data?.user.expected_monthly_salary_cent).toBe(75000);

    const dbAfterSet = await getTestPrisma().user.findUnique({ where: { id: employee.id } });
    expect(dbAfterSet?.expected_monthly_salary_cent).toBe(75000);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'User', entity_id: employee.id, action: 'user.update' },
      orderBy: { at: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit?.before_json as { expected_monthly_salary_cent?: number | null } | null)?.expected_monthly_salary_cent).toBeNull();
    expect((audit?.after_json as { expected_monthly_salary_cent?: number | null } | null)?.expected_monthly_salary_cent).toBe(75000);

    // The owner clears it back to unset the same way he set it.
    const clearRes = await fetch(`${BASE_URL}/api/admin/users/${employee.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('sal'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ expectedMonthlySalaryCent: null }),
    });
    expect(clearRes.status).toBe(200);
    const dbAfterClear = await getTestPrisma().user.findUnique({ where: { id: employee.id } });
    expect(dbAfterClear?.expected_monthly_salary_cent).toBeNull();
  });

  it('POST /api/admin/users/:id/reset-password returns temp_password', async () => {
    const admin = await seedTestUser({ username: 'u-admin3', role: Role.ADMIN });
    const employee = await seedTestUser({ username: 'u-emp3' });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${employee.id}/reset-password`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idemKey('rp'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { temp_password: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.data?.temp_password).toBe('string');
    expect(body.data?.temp_password.length).toBeGreaterThan(0);
  });

  it('POST /api/admin/users/:id/deactivate sets is_active=false', async () => {
    const admin = await seedTestUser({ username: 'u-admin4', role: Role.ADMIN });
    const employee = await seedTestUser({ username: 'u-emp4' });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${employee.id}/deactivate`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idemKey('deact'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
    });
    expect(res.status).toBe(200);

    const dbUser = await getTestPrisma().user.findUnique({ where: { id: employee.id } });
    expect(dbUser?.is_active).toBe(false);
  });
});