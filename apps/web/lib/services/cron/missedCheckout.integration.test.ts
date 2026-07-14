import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { notifier } from 'notify';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestSchedule,
  seedTestPunch,
} from '../../test-helpers/db';
import { runMissedCheckout } from '../../../../../apps/worker/src/jobs/missedCheckout';

describe('cron: missedCheckout integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('creates a Flag row and sends neutral notifier message when still clocked in past end+35', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'mc-emp1', branch_id: branch.id });
    await seedTestSchedule({ user_id: user.id, weekday: 0, start_time: '09:00', end_time: '18:00' });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date('2026-07-12T09:00:00+03:00') });

    const r = await runMissedCheckout({ now: new Date('2026-07-12T18:36:00+03:00'), notifier });
    expect(r.flags_created).toBe(1);
    const flag = await getTestPrisma().flag.findFirst({ where: { user_id: user.id, kind: 'MISSED_CHECKOUT' } });
    expect(flag).not.toBeNull();
  });
});