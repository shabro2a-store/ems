import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestSchedule,
  seedTestFlag,
} from '../../test-helpers/db';
import { runWatchedDetector } from '../../../../../apps/worker/src/jobs/watchedDetector';

describe('cron: watchedDetector integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  // All three fixtures judge Sunday 2026-07-12 (Beirut weekday 0) as the day
  // that just closed, by running the job just after midnight on Monday.
  const AFTER_MIDNIGHT = new Date('2026-07-13T00:10:00+03:00');

  it('creates a Flag row for an active user with zero punches on the closed day', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'wd-emp1', branch_id: branch.id });
    await seedTestSchedule({ user_id: user.id, weekday: 0, shift_min: 540 });

    const r = await runWatchedDetector({ now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(1);
    const flag = await getTestPrisma().flag.findFirst({ where: { user_id: user.id, kind: 'WATCHED' } });
    expect(flag).not.toBeNull();
    expect(flag?.notified_at).toBeNull();
  });

  it('skips user with approved DAY_OFF override', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'wd-emp2', branch_id: branch.id });
    await seedTestSchedule({ user_id: user.id, weekday: 0, shift_min: 540 });
    const dayOffDate = new Date('2026-07-12T00:00:00.000Z');
    await getTestPrisma().scheduleOverride.create({
      data: { user_id: user.id, date: dayOffDate, kind: 'DAY_OFF', source: 'ADMIN_DIRECT' },
    });

    const r = await runWatchedDetector({ now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(0);
    expect(r.skipped_day_off).toBe(1);
  });

  it('does not duplicate a flag on second run', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'wd-emp3', branch_id: branch.id });
    await seedTestSchedule({ user_id: user.id, weekday: 0, shift_min: 540 });
    // Within the closed day itself (2026-07-12), matching the dedup guard's
    // own window - distinct from AFTER_MIDNIGHT, which is when the job runs.
    await seedTestFlag({
      kind: 'WATCHED',
      user_id: user.id,
      created_at: new Date('2026-07-12T10:00:00+03:00'),
      context_json: { shift_min: 480, date: '2026-07-12' },
    });

    const r = await runWatchedDetector({ now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(0);
  });
});