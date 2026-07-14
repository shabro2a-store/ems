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

  it('creates a Flag row for an active user without a punch past start+30min', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'wd-emp1', branch_id: branch.id });
    const now = new Date('2026-07-12T10:00:00+03:00');
    const wd = 0;
    await seedTestSchedule({ user_id: user.id, weekday: wd, start_time: '09:00', end_time: '18:00' });

    const r = await runWatchedDetector({ now });
    expect(r.flags_created).toBe(1);
    const flag = await getTestPrisma().flag.findFirst({ where: { user_id: user.id, kind: 'WATCHED' } });
    expect(flag).not.toBeNull();
    expect(flag?.notified_at).toBeNull();
  });

  it('skips user with approved DAY_OFF override', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'wd-emp2', branch_id: branch.id });
    const now = new Date('2026-07-12T10:00:00+03:00');
    await seedTestSchedule({ user_id: user.id, weekday: 0, start_time: '09:00', end_time: '18:00' });
    const today = new Date('2026-07-12T00:00:00.000Z');
    await getTestPrisma().scheduleOverride.create({
      data: { user_id: user.id, date: today, kind: 'DAY_OFF', source: 'ADMIN_DIRECT' },
    });

    const r = await runWatchedDetector({ now });
    expect(r.flags_created).toBe(0);
    expect(r.skipped_day_off).toBe(1);
  });

  it('does not duplicate a flag on second run', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'wd-emp3', branch_id: branch.id });
    await seedTestSchedule({ user_id: user.id, weekday: 0, start_time: '09:00', end_time: '18:00' });
    const now = new Date('2026-07-12T10:00:00+03:00');
    await seedTestFlag({ kind: 'WATCHED', user_id: user.id, created_at: now, context_json: { scheduled_start: '09:00' } });

    const r = await runWatchedDetector({ now });
    expect(r.flags_created).toBe(0);
  });
});