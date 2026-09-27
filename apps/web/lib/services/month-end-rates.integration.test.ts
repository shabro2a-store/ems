import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb, seedTestUser, seedTestRateChange } from '../test-helpers/db';
import { monthEndRates } from './payrollRates';
import { prisma } from '@/lib/db/prisma';

/*
 * Money #29: the rate column. The screen printed the rate the month ended on,
 * or TODAY's rate when there was none; the PDF printed $0 there. One helper for
 * both now, and the fallback is the rate the person started on - what their
 * hours were paid at (money #32).
 */
describe('the rate beside a month', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  async function person(username: string, current: number, rates: Array<[number, string]>) {
    const u = await seedTestUser({ username, hourly_rate_cent: current });
    await getTestPrisma().rateChange.deleteMany({ where: { user_id: u.id } });
    for (const [rate_cent, at] of rates) await seedTestRateChange({ user_id: u.id, rate_cent, effective_from: new Date(at) });
    return u;
  }

  it('is the one in force when the month ended, else the first, else the current', async () => {
    const raised = await person('mer-raised', 600, [[400, '2026-01-01T00:00:00Z'], [500, '2026-08-20T00:00:00Z'], [600, '2026-09-10T00:00:00Z']]);
    const lateFirst = await person('mer-late', 350, [[350, '2026-09-05T00:00:00Z']]);
    const noHistory = await person('mer-none', 275, []);

    const rates = await monthEndRates(prisma, [raised, lateFirst, noHistory], '2026-08');
    expect(rates.get(raised.id)).toBe(500);
    expect(rates.get(lateFirst.id)).toBe(350);
    expect(rates.get(noHistory.id)).toBe(275);
  });
});
