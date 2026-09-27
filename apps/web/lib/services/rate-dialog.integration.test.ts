import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestRateChange } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #22: the rate dialog on the payroll screen started from the rate of the MONTH
 * on screen. Looking at August ($4) after a raise to $5 and pressing Save
 * without touching anything wrote $4 as the rate from now on - a pay cut
 * nobody asked for. The dialog needs today's rate, so the table has to carry it
 * beside the rate the month was paid at.
 */
describe('the payroll table', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('carries today\'s rate beside the rate the month was paid at', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'rate-raised', branch_id: branch.id, hourly_rate_cent: 500 });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 400, effective_from: new Date('2026-01-01T00:00:00Z') });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 500, effective_from: new Date('2026-09-01T00:00:00Z') });
    await seedTestUser({ username: 'rate-admin', role: Role.ADMIN });
    const admin = await loginAs('rate-admin', 'test-pass-1');

    const res = await fetch(`${BASE_URL}/api/admin/payroll?month=2026-08`, { headers: { Cookie: admin.cookies } });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: { rows: Array<{ user_id: string; rate_cent: number; current_rate_cent: number }> } }).data.rows;
    const row = rows.find((r) => r.user_id === emp.id)!;
    expect(row.rate_cent).toBe(400);
    expect(row.current_rate_cent).toBe(500);
  });
});
