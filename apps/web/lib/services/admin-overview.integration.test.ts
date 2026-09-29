import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut, todayInBeirutDateRange, beirutWeekday } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestPunch,
  seedTestSchedule,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

interface Person {
  username: string;
  status: 'IN' | 'ON_TRIP' | 'DAY_OFF' | 'ABSENT' | 'LEFT';
  since_min: number;
  hours_today: number;
}

async function overview(session: { cookies: string; csrf: string }) {
  const res = await fetch(`${BASE_URL}/api/admin/overview?branchId=all`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    data: { people: Person[]; kpis: { absent: number; present: number; hoursToday: number; laborTodayCent: number } };
  };
  expect(body.ok).toBe(true);
  return body.data;
}

describe('admin overview: who counts as off today (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('renders a full day of approved time off as off, not absent', async () => {
    // The dashboard used to ask only "is there a DAY_OFF override", which an
    // approved full-shift time-off request does not write - decideLeave writes
    // HOURS_CHANGE with shift_min 0. The owner approved the leave and then saw
    // the same person listed Absent all day.
    const branch = await seedTestBranch();
    const today = todayInBeirut();
    const weekday = beirutWeekday(new Date());

    const onLeave = await seedTestUser({ username: 'ov-onleave', branch_id: branch.id });
    const noShow = await seedTestUser({ username: 'ov-noshow', branch_id: branch.id });
    const unscheduled = await seedTestUser({ username: 'ov-unscheduled', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'ov-admin', role: Role.ADMIN });

    await seedTestSchedule({ user_id: onLeave.id, weekday, shift_min: 480 });
    await seedTestSchedule({ user_id: noShow.id, weekday, shift_min: 480 });
    await getTestPrisma().scheduleOverride.create({
      data: {
        user_id: onLeave.id,
        date: new Date(`${today}T00:00:00.000Z`),
        kind: 'HOURS_CHANGE',
        shift_min: 0,
        source: 'EMPLOYEE_REQUEST',
      },
    });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const by = new Map(data.people.map((p) => [p.username, p.status]));

    expect(by.get('ov-onleave')).toBe('DAY_OFF');
    // The control: same schedule, no override, no punches - still absent.
    expect(by.get('ov-noshow')).toBe('ABSENT');
    // Nobody is scheduled on an unset weekday either, which the absence
    // detector already agrees is not a no-show.
    expect(by.get('ov-unscheduled')).toBe('DAY_OFF');
    expect(unscheduled.id).toBeTruthy();
    expect(data.kpis.absent).toBe(1);
  });

  it('still counts a partial time-off day as a day they are expected in', async () => {
    const branch = await seedTestBranch();
    const today = todayInBeirut();
    const weekday = beirutWeekday(new Date());

    const partial = await seedTestUser({ username: 'ov-partial', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'ov-admin2', role: Role.ADMIN });
    await seedTestSchedule({ user_id: partial.id, weekday, shift_min: 480 });
    await getTestPrisma().scheduleOverride.create({
      data: {
        user_id: partial.id,
        date: new Date(`${today}T00:00:00.000Z`),
        kind: 'HOURS_CHANGE',
        shift_min: 240,
        source: 'EMPLOYEE_REQUEST',
      },
    });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const by = new Map(data.people.map((p) => [p.username, p.status]));
    expect(by.get('ov-partial')).toBe('ABSENT');
  });
});

describe('admin overview: an overnight shift after midnight (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('still shows a 21:00 arrival as present, with hours, once the day has rolled over', async () => {
    // The board used to fetch only punches inside today's Beirut day, so at
    // midnight the arrival moved into "yesterday" and the person vanished from
    // "Who's in right now" with hours_today reading 0 for the rest of the night.
    const branch = await seedTestBranch();
    const today = todayInBeirut();
    const weekday = beirutWeekday(new Date());
    const { startUtc } = todayInBeirutDateRange(today);
    // 21:00 Beirut yesterday, still open: the shift-day is yesterday whatever
    // the clock says when this runs, which is what the board must handle.
    const inAt = new Date(startUtc.getTime() - 3 * 60 * 60 * 1000);

    const overnight = await seedTestUser({ username: 'ov-overnight', branch_id: branch.id });
    const noShow = await seedTestUser({ username: 'ov-daystaff', branch_id: branch.id });
    const finished = await seedTestUser({ username: 'ov-finished', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'ov-admin3', role: Role.ADMIN });
    await seedTestSchedule({ user_id: overnight.id, weekday, shift_min: 600 });
    await seedTestSchedule({ user_id: noShow.id, weekday, shift_min: 480 });
    await seedTestSchedule({ user_id: finished.id, weekday, shift_min: 480 });
    await seedTestPunch({ user_id: overnight.id, branch_id: branch.id, kind: 'IN', at: inAt });
    // Worked 15:00-17:00 Beirut yesterday and went home. Widening the punch
    // window is only half the fix: without the shift-day attribution those two
    // hours would land on today's total. Early enough that the rest window has
    // closed by midnight - a shift ending at 23:00 is still the day in progress
    // until 03:15, and would rightly count.
    await seedTestPunch({
      user_id: finished.id,
      branch_id: branch.id,
      kind: 'IN',
      at: new Date(startUtc.getTime() - 9 * 60 * 60 * 1000),
    });
    await seedTestPunch({
      user_id: finished.id,
      branch_id: branch.id,
      kind: 'OUT',
      at: new Date(startUtc.getTime() - 7 * 60 * 60 * 1000),
    });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const by = new Map(data.people.map((p) => [p.username, p]));

    const row = by.get('ov-overnight');
    expect(row?.status).toBe('IN');
    expect(row?.hours_today).toBeGreaterThanOrEqual(3);
    expect(row?.since_min).toBeGreaterThanOrEqual(180);
    expect(data.kpis.present).toBe(1);
    expect(data.kpis.hoursToday).toBeGreaterThanOrEqual(3);

    // The control: same branch, scheduled today, never turned up.
    expect(by.get('ov-daystaff')?.status).toBe('ABSENT');
    expect(by.get('ov-daystaff')?.hours_today).toBe(0);

    // Yesterday's closed shift stays on yesterday.
    expect(by.get('ov-finished')?.status).toBe('ABSENT');
    expect(by.get('ov-finished')?.hours_today).toBe(0);
  });

  it('counts both of today\'s sessions, not just the open one', async () => {
    const branch = await seedTestBranch();
    const weekday = beirutWeekday(new Date());
    // Ending ten minutes ago, not at a fixed hour: the day in progress lasts
    // only as long as the rest window after the last checkout, so sessions
    // anchored to this morning read as a finished day by the afternoon.
    const secondOut = new Date(Date.now() - 10 * 60 * 1000);
    const second = new Date(secondOut.getTime() - 60 * 60 * 1000);
    const firstOut = new Date(second.getTime() - 30 * 60 * 1000);
    const first = new Date(firstOut.getTime() - 60 * 60 * 1000);

    const emp = await seedTestUser({ username: 'ov-two-sessions', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'ov-admin4', role: Role.ADMIN });
    await seedTestSchedule({ user_id: emp.id, weekday, shift_min: 480 });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: first });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: firstOut });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: second });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: secondOut });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const row = data.people.find((p) => p.username === 'ov-two-sessions');
    expect(row?.hours_today).toBe(2);
  });
});

describe('admin overview: a forgotten checkout (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('does not report a two-day-old open punch as someone still working', async () => {
    // missedCheckout raises a MISSED_CHECKOUT flag but never closes the punch,
    // so the row stays open indefinitely. Widening the board's punch query to
    // two days means it now sees such a punch - and counting it would show the
    // person present with ~40 hours on the day, feeding kpis.laborTodayCent,
    // which is the number the owner reads to judge the day.
    const branch = await seedTestBranch();
    const weekday = beirutWeekday(new Date());
    const forgot = await seedTestUser({ username: 'ov-forgot', branch_id: branch.id, hourly_rate_cent: 1000 });
    const admin = await seedTestUser({ username: 'ov-admin5', role: Role.ADMIN });
    await seedTestSchedule({ user_id: forgot.id, weekday, shift_min: 480 });
    await seedTestPunch({
      user_id: forgot.id,
      branch_id: branch.id,
      kind: 'IN',
      at: new Date(Date.now() - 40 * 60 * 60 * 1000),
    });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const row = data.people.find((p) => p.username === 'ov-forgot');

    expect(row?.status).toBe('ABSENT');
    expect(row?.hours_today).toBe(0);
    expect(data.kpis.present).toBe(0);
    expect(data.kpis.hoursToday).toBe(0);
    expect(data.kpis.laborTodayCent).toBe(0);
  });

  /*
   * #37: somebody who worked today and has clocked out was shown - and counted -
   * as Absent, because the board only knew "in right now" or "not here".
   */
  it('shows somebody who worked today and went home as left, not absent', async () => {
    const branch = await seedTestBranch();
    const weekday = beirutWeekday(new Date());
    const worker = await seedTestUser({ username: 'ov-left', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'ov-admin6', role: Role.ADMIN });
    await seedTestSchedule({ user_id: worker.id, weekday, shift_min: 480 });
    // An hour, ending ten minutes ago: the day in progress whatever time this
    // runs. Anchored to midnight instead (a quarter and a half of the time since
    // it), the first minutes of the day left a session too short to show any
    // hours, and the test failed between 00:00 and 00:12 Beirut.
    const now = Date.now();
    await seedTestPunch({ user_id: worker.id, branch_id: branch.id, kind: 'IN', at: new Date(now - 70 * 60_000) });
    await seedTestPunch({ user_id: worker.id, branch_id: branch.id, kind: 'OUT', at: new Date(now - 10 * 60_000) });

    const session = await loginAs(admin.username, 'test-pass-1');
    const data = await overview(session);
    const row = data.people.find((p) => p.username === 'ov-left');
    expect(row?.status).toBe('LEFT');
    expect(row?.hours_today).toBeGreaterThan(0);
    expect(data.kpis.absent).toBe(0);
  });
});
