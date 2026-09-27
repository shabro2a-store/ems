import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestRateChange } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';
import { currentPayMonth } from './periodLock';

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

  /*
   * Money #30: the page decided "closed" from the BROWSER's month. On the 1st,
   * inside the grace the server gives the month just ended, the owner's screen
   * locked a month the server still took changes for - and a phone with a
   * wrong clock unlocked a month that was paid. The server says which it is.
   */
  it("says whether the month on screen is still open, by the server's clock", async () => {
    await seedTestUser({ username: 'open-admin', role: Role.ADMIN });
    const admin = await loginAs('open-admin', 'test-pass-1');
    const get = async (q: string) =>
      ((await (await fetch(`${BASE_URL}/api/admin/payroll${q}`, { headers: { Cookie: admin.cookies } })).json()) as {
        data: { month: string; open: boolean };
      }).data;

    const current = currentPayMonth();
    expect(await get('')).toMatchObject({ month: current, open: true });
    expect((await get(`?month=${current}`)).open).toBe(true);
    const [y, m] = current.split('-').map(Number);
    const previous = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
    expect((await get(`?month=${previous}`)).open).toBe(false);
  });
});
