import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { beirutWeekday, todayInBeirut } from 'time';
import { getTestPrisma, cleanDb, seedTestUser, seedTestBranch, seedTestPunch, seedTestRateChange, seedTestSchedule } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';
import { beirutAt } from '../test-helpers/days';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';
const key = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function call(session: { cookies: string; csrf: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key('ot'),
      'X-CSRF-Token': session.csrf,
      Cookie: session.cookies,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: any; error?: { code: string } } };
}

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/*
 * Overtime at each person's own rate (the owner's rule, 2026-10-01), end to
 * end: the owner sets it on the person, payroll pays it, and nothing before
 * October moves.
 */
describe('the overtime rate (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });
  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('is set on the person: the first rate covers this month, a change applies from today, blank goes back to the hourly rate', async () => {
    const db = getTestPrisma();
    const admin = await seedTestUser({ username: 'ot-admin1', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'ot-emp1', branch_id: branch.id, hourly_rate_cent: 200 });
    const session = await loginAs(admin.username, 'test-pass-1');
    const today = todayInBeirut();
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const rows = async () =>
      (await db.overtimeRateChange.findMany({ where: { user_id: emp.id }, orderBy: { effective_from: 'asc' } })).map((r) => ({
        date: r.effective_from.toISOString().slice(0, 10),
        rate: r.rate_cent,
      }));

    expect((await call(session, 'PATCH', `/api/admin/users/${emp.id}`, { overtimeRateCent: 300 })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: emp.id } })).overtime_rate_cent).toBe(300);
    expect(await rows()).toEqual([{ date: firstOfMonth, rate: 300 }]);

    // Saving the same rate again writes nothing.
    await call(session, 'PATCH', `/api/admin/users/${emp.id}`, { overtimeRateCent: 300, hourlyRateCent: 200 });
    expect(await rows()).toHaveLength(1);

    await call(session, 'PATCH', `/api/admin/users/${emp.id}`, { overtimeRateCent: 350 });
    const afterChange = await rows();
    expect(afterChange.at(-1)).toEqual({ date: today, rate: 350 });

    await call(session, 'PATCH', `/api/admin/users/${emp.id}`, { overtimeRateCent: null });
    expect((await db.user.findUniqueOrThrow({ where: { id: emp.id } })).overtime_rate_cent).toBeNull();
    expect((await rows()).at(-1)).toEqual({ date: today, rate: null });

    const audit = await db.auditLog.findFirst({ where: { action: 'user.update', entity_id: emp.id }, orderBy: { at: 'desc' } });
    expect((audit?.before_json as { overtime_rate_cent: number }).overtime_rate_cent).toBe(350);
    expect((audit?.after_json as { overtime_rate_cent: number | null }).overtime_rate_cent).toBeNull();
  });

  it('can be given when the person is created', async () => {
    const db = getTestPrisma();
    const admin = await seedTestUser({ username: 'ot-admin2', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'test-pass-1');
    const res = await call(session, 'POST', '/api/admin/users', {
      username: 'ot-new', password: 'test-pass-1', role: 'EMPLOYEE', branchId: branch.id, hourlyRateCent: 200, overtimeRateCent: 400,
    });
    expect(res.status).toBe(200);
    const id = res.body.data.user.id as string;
    expect((await db.user.findUniqueOrThrow({ where: { id } })).overtime_rate_cent).toBe(400);
    const [row] = await db.overtimeRateChange.findMany({ where: { user_id: id } });
    expect(row!.effective_from.toISOString().slice(0, 10)).toBe(`${todayInBeirut().slice(0, 7)}-01`);
  });

  it('comes back on the staff list with the trip rate, so editing a driver starts from both', async () => {
    const admin = await seedTestUser({ username: 'ot-admin3', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const driver = await seedTestUser({ username: 'ot-driver', role: Role.DRIVER, branch_id: branch.id });
    await getTestPrisma().user.update({ where: { id: driver.id }, data: { trip_rate_cent: 150, overtime_rate_cent: 275 } });
    const session = await loginAs(admin.username, 'test-pass-1');
    const res = await call(session, 'GET', '/api/admin/users');
    const row = (res.body.data.users as Array<{ id: string; trip_rate_cent: number; overtime_rate_cent: number | null }>).find((u) => u.id === driver.id);
    expect(row).toMatchObject({ trip_rate_cent: 150, overtime_rate_cent: 275 });
  });

  it('pays October overtime at the overtime rate and leaves September as it was', async () => {
    const db = getTestPrisma();
    const admin = await seedTestUser({ username: 'ot-admin4', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'ot-emp4', branch_id: branch.id, hourly_rate_cent: 200 });
    await seedTestRateChange({ user_id: emp.id, rate_cent: 200, effective_from: new Date('2026-01-01T00:00:00Z') });
    // 8h days on both weekdays used below.
    for (const d of ['2026-09-29', '2026-10-05']) {
      await seedTestSchedule({ user_id: emp.id, weekday: beirutWeekday(day(d)), shift_min: 480 });
      // 08:00-17:30: 570 minutes, 90 of them overtime.
      await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: beirutAt(d, '08:00') });
      await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: beirutAt(d, '17:30') });
    }
    // Dated before the start on purpose: September must still not move.
    await db.overtimeRateChange.create({ data: { user_id: emp.id, rate_cent: 300, effective_from: day('2026-09-01') } });
    const session = await loginAs(admin.username, 'test-pass-1');

    const oct = await call(session, 'GET', '/api/admin/payroll?month=2026-10');
    const octRow = (oct.body.data.rows as any[]).find((r) => r.user_id === emp.id);
    // 570 min at $2 = 1900, plus 90 min repriced from $2 to $3 = 150.
    expect(octRow).toMatchObject({ gross_cent: 2050, overtime_premium_cent: 150, overtime_rate_cent: 300, current_overtime_rate_cent: null });
    expect(oct.body.data.totals.overtime_premium_cent).toBe(150);

    const ot = await call(session, 'GET', `/api/admin/overtime?userId=${emp.id}&month=2026-10`);
    expect(ot.body.data.overtime[0]).toMatchObject({ date: '2026-10-05', overtimeMin: 90, rate_cent: 300, amount_cent: 450, premium_cent: 150 });

    const sep = await call(session, 'GET', '/api/admin/payroll?month=2026-09');
    const sepRow = (sep.body.data.rows as any[]).find((r) => r.user_id === emp.id);
    expect(sepRow).toMatchObject({ gross_cent: 1900, overtime_premium_cent: 0, overtime_rate_cent: null });

    const pdf = await fetch(`${BASE_URL}/api/admin/reports/payroll?month=2026-10`, { headers: { Cookie: session.cookies } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not stop a person who never worked from being deleted', async () => {
    const db = getTestPrisma();
    const admin = await seedTestUser({ username: 'ot-admin5', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'test-pass-1');
    const res = await call(session, 'POST', '/api/admin/users', {
      username: 'ot-gone', password: 'test-pass-1', role: 'DRIVER', branchId: branch.id, hourlyRateCent: 200, tripRateCent: 150, overtimeRateCent: 300,
    });
    const id = res.body.data.user.id as string;
    const del = await call(session, 'DELETE', `/api/admin/users/${id}`);
    expect(del.status).toBe(200);
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
  });
});
