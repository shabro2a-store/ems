import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestRateChange, seedTestPunch } from '../test-helpers/db';
import { payoutForUser } from './payout';
import { prisma } from '@/lib/db/prisma';

/*
 * Money #27. A shift is priced at the rate in force when it CLOSED, and the
 * night on a month's seam closes in the next month - so its punches are read
 * past the month's end. The rates were not: they stopped at the month's end,
 * so a raise at 03:00 on the 1st never reached the night that ended at 06:00.
 */
describe('the night on the seam', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('is paid at the rate in force when it ended, even after the month turned', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'seam-rate', branch_id: branch.id, hourly_rate_cent: 400 });
    await getTestPrisma().rateChange.deleteMany({ where: { user_id: emp.id } });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 400, effective_from: new Date('2026-01-01T00:00:00Z') });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 500, effective_from: new Date('2026-09-01T03:00:00+03:00') });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date('2026-08-31T22:00:00+03:00') });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date('2026-09-01T06:00:00+03:00') });

    const august = await payoutForUser(emp.id, '2026-08', prisma);
    expect(august.grossCent).toBe(8 * 500);
  });
});
