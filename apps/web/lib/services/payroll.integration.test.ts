import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestPunch,
  seedTestRateChange,
  seedTestAdjustment,
  seedTestAdvance,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('admin payroll integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('returns full table with rows and totals for a valid month', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const emp1 = await seedTestUser({ username: 'pay-emp1', branch_id: branch.id });
    const emp2 = await seedTestUser({ username: 'pay-emp2', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'pay-admin', role: Role.ADMIN });

    await seedTestPunch({ user_id: emp1.id, branch_id: branch.id, kind: 'IN', at: new Date('2026-07-01T08:00:00Z') });
    await seedTestPunch({ user_id: emp1.id, branch_id: branch.id, kind: 'OUT', at: new Date('2026-07-01T16:00:00Z') });
    await seedTestPunch({ user_id: emp2.id, branch_id: branch.id, kind: 'IN', at: new Date('2026-07-02T08:00:00Z') });
    await seedTestPunch({ user_id: emp2.id, branch_id: branch.id, kind: 'OUT', at: new Date('2026-07-02T14:00:00Z') });
    await seedTestRateChange({ user_id: emp1.id, rate_cent: 200, effective_from: new Date('2026-01-01T00:00:00Z') });
    await seedTestRateChange({ user_id: emp2.id, rate_cent: 300, effective_from: new Date('2026-01-01T00:00:00Z') });
    // Both must be pinned to the asserted month (2026-07): the adjustment is
    // matched by period and the advance by created_at, and either defaulting to
    // "now" makes this test fail from the next month onward.
    await seedTestAdjustment({ user_id: emp1.id, kind: 'BONUS', amount_cent: 1000, created_by: admin.id, period: new Date('2026-07-01T00:00:00.000Z') });
    await seedTestAdvance({ user_id: emp1.id, amount_cent: 500, status: 'APPROVED', decided_by: admin.id, decided_at: new Date('2026-07-10T00:00:00Z'), created_at: new Date('2026-07-10T00:00:00Z') });

    const aSession = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/payroll?month=2026-07`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        rows: Array<{ username: string; hours: number; gross_cent: number; adjustments_cent: number; advances_cent: number; net_cent: number }>;
        totals: { hours: number; gross_cent: number; adjustments_cent: number; advances_cent: number; net_cent: number };
        month: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.month).toBe('2026-07');
    expect(body.data.rows.length).toBeGreaterThanOrEqual(2);

    const e1 = body.data.rows.find((r) => r.username === 'pay-emp1');
    expect(e1).toBeTruthy();
    expect(e1!.hours).toBe(8);
    expect(e1!.gross_cent).toBe(1600);
    expect(e1!.adjustments_cent).toBe(1000);
    expect(e1!.advances_cent).toBe(500);
    expect(e1!.net_cent).toBe(2100);

    expect(body.data.totals.gross_cent).toBe(1600 + 1800);
    expect(body.data.totals.adjustments_cent).toBe(1000);
  });

  it('returns 400 INVALID_INPUT for invalid month', async () => {
    const admin = await seedTestUser({ username: 'pay-admin2', role: Role.ADMIN });
    const aSession = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/payroll?month=invalid`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('INVALID_INPUT');
  });

  it('expected monthly salary is reference only — payroll totals unaffected by setting it', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const emp = await seedTestUser({ username: 'pay-salary-emp', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'pay-salary-admin', role: Role.ADMIN });

    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date('2026-07-01T08:00:00Z') });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date('2026-07-01T16:00:00Z') });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 200, effective_from: new Date('2026-01-01T00:00:00Z') });

    const aSession = await loginAs(admin.username, 'change-me');

    async function fetchPayroll() {
      const res = await fetch(`${BASE_URL}/api/admin/payroll?month=2026-07`, {
        headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        data: {
          rows: Array<{
            user_id: string;
            expected_salary_cent: number | null;
            hours: number;
            gross_cent: number;
            adjustments_cent: number;
            advances_cent: number;
            penalties_cent: number;
            overtime_deduction_cent: number;
            net_cent: number;
          }>;
          totals: Record<string, number>;
        };
      };
    }

    const before = await fetchPayroll();
    const beforeRow = before.data.rows.find((r) => r.user_id === emp.id);
    expect(beforeRow).toBeTruthy();
    expect(beforeRow!.expected_salary_cent).toBeNull();
    expect(beforeRow!.gross_cent).toBe(1600);
    expect(beforeRow!.net_cent).toBe(1600);

    // A deliberately huge, distinctive figure: if it ever leaks into a
    // calculation, the totals below move by an unmistakable amount.
    const patchRes = await fetch(`${BASE_URL}/api/admin/users/${emp.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sal-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({ expectedMonthlySalaryCent: 99_999_900 }),
    });
    expect(patchRes.status).toBe(200);

    const after = await fetchPayroll();
    const afterRow = after.data.rows.find((r) => r.user_id === emp.id);
    expect(afterRow).toBeTruthy();
    // The figure really did get set...
    expect(afterRow!.expected_salary_cent).toBe(99_999_900);
    // ...but every money and hours figure is untouched, row and totals alike.
    expect(afterRow!.hours).toBe(beforeRow!.hours);
    expect(afterRow!.gross_cent).toBe(beforeRow!.gross_cent);
    expect(afterRow!.adjustments_cent).toBe(beforeRow!.adjustments_cent);
    expect(afterRow!.advances_cent).toBe(beforeRow!.advances_cent);
    expect(afterRow!.penalties_cent).toBe(beforeRow!.penalties_cent);
    expect(afterRow!.overtime_deduction_cent).toBe(beforeRow!.overtime_deduction_cent);
    expect(afterRow!.net_cent).toBe(beforeRow!.net_cent);
    expect(after.data.totals).toEqual(before.data.totals);
  });

  it('returns 403 for non-admin', async () => {
    const branch = await seedTestBranch();
    const employee = await seedTestUser({ username: 'pay-emp3', branch_id: branch.id });
    const eSession = await loginAs(employee.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/payroll?month=2026-07`, {
      headers: { Cookie: eSession.cookies, 'X-CSRF-Token': eSession.csrf },
    });
    expect(res.status).toBe(403);
  });
});