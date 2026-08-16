import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut, beirutWeekday } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestSchedule,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

interface Person {
  username: string;
  status: 'IN' | 'ON_TRIP' | 'DAY_OFF' | 'ABSENT';
}

async function overview(session: { cookies: string; csrf: string }) {
  const res = await fetch(`${BASE_URL}/api/admin/overview?branchId=all`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    data: { people: Person[]; kpis: { absent: number } };
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

    const session = await loginAs(admin.username, 'change-me');
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

    const session = await loginAs(admin.username, 'change-me');
    const data = await overview(session);
    const by = new Map(data.people.map((p) => [p.username, p.status]));
    expect(by.get('ov-partial')).toBe('ABSENT');
  });
});
