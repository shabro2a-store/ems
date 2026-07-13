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
    await seedTestAdjustment({ user_id: emp1.id, kind: 'BONUS', amount_cent: 1000, created_by: admin.id });
    await seedTestAdvance({ user_id: emp1.id, amount_cent: 500, status: 'APPROVED', decided_by: admin.id, decided_at: new Date('2026-07-10T00:00:00Z') });

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