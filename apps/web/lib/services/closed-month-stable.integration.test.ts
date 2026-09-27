import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { scheduledToUtc } from 'time';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestPunch, seedTestRateChange, seedTestSchedule } from '../test-helpers/db';
import { loginAs, type LoginSession } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #19 through the real routes: changing somebody's weekly hours today must not
 * re-judge a day in a month that has closed and been paid. August 2026 is
 * closed from here on, so this cannot age into a date bomb.
 */
async function penaltiesFor(admin: LoginSession, userId: string, month: string) {
  const res = await fetch(`${BASE_URL}/api/admin/penalties?userId=${userId}&month=${month}`, {
    headers: { Cookie: admin.cookies },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { penalties: Array<{ date: string }> } }).data.penalties;
}

describe('editing the weekly hours', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('applies from today and leaves a paid month as it was paid', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'sched-hist', branch_id: branch.id, hourly_rate_cent: 600 });
    await seedTestUser({ username: 'sched-admin', role: Role.ADMIN });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });
    // Mondays 8h, and Monday 3 August worked 08:00-16:00: exactly what was owed.
    await seedTestSchedule({ user_id: emp.id, weekday: 1, shift_min: 480 });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: scheduledToUtc('2026-08-03', '08:00') });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: scheduledToUtc('2026-08-03', '16:00') });
    const admin = await loginAs('sched-admin', 'change-me');
    expect(await penaltiesFor(admin, emp.id, '2026-08')).toEqual([]);

    const put = await fetch(`${BASE_URL}/api/admin/schedules/${emp.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookies, 'X-CSRF-Token': admin.csrf },
      body: JSON.stringify({ weeklySchedule: [{ weekday: 1, shift_hours: 9 }] }),
    });
    expect(put.status).toBe(200);

    // August is judged against the 8h it had, not today's 9h.
    expect(await penaltiesFor(admin, emp.id, '2026-08')).toEqual([]);
    // Today's week shows the change, and the old hours are still on record.
    const got = await fetch(`${BASE_URL}/api/admin/schedules/${emp.id}`, { headers: { Cookie: admin.cookies } });
    const week = ((await got.json()) as { data: { weeklySchedule: Array<{ weekday: number; shift_min: number }> } }).data.weeklySchedule;
    expect(week.map((r) => [r.weekday, r.shift_min])).toEqual([[1, 540]]);
    const rows = await getTestPrisma().schedule.findMany({ where: { user_id: emp.id }, orderBy: { effective_from: 'asc' } });
    expect(rows.map((r) => r.shift_min)).toEqual([480, 540]);
  });
});
