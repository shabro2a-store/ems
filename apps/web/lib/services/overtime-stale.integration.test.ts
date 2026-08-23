import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { beirutWeekday } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestPunch,
  seedTestRateChange,
  seedTestSchedule,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';
import { overtimeDeductionForUser, pendingOvertimeNotices } from './overtime';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

const MONTH = '2026-07';
const DAY = '2026-07-01';
const RATE_CENT = 200; // $2.00/h

// Session 1: Beirut 08:00-18:00, 600 min against a 480 min shift = 120 over.
const IN_1 = new Date('2026-07-01T05:00:00Z');
const OUT_1 = new Date('2026-07-01T15:00:00Z');
// Session 2, same Beirut day: 19:00-22:00, another 180 min. 780 worked = 300 over.
const IN_2 = new Date('2026-07-01T16:00:00Z');
const OUT_2 = new Date('2026-07-01T19:00:00Z');

const OVER_1_MIN = 120;
const OVER_2_MIN = 300;
const OVER_1_CENT = 400; // $4.00 - what the owner actually agreed to revoke
const OVER_2_CENT = 1000; // $10.00 - what the stale decision used to take
const GROSS_1_CENT = 2000;
const GROSS_2_CENT = 2600;

interface PayrollRow {
  username: string;
  gross_cent: number;
  overtime_deduction_cent: number;
  net_cent: number;
}

interface OvertimeItem {
  date: string;
  overtimeMin: number;
  amount_cent: number;
  decision: 'ACCEPTED' | 'REVOKED' | null;
}

function idemKey(): string {
  return `ots-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setup() {
  const branch = await seedTestBranch({ name: 'Hamra', shift_grace_min: 15 });
  const emp = await seedTestUser({ username: 'ots-emp', branch_id: branch.id, hourly_rate_cent: RATE_CENT });
  const admin = await seedTestUser({ username: 'ots-admin', role: Role.ADMIN });
  // seedTestUser's own RateChange starts "now", which is after the month under
  // test, so July would price at zero without this.
  await seedTestRateChange({ user_id: emp.id, rate_cent: RATE_CENT, effective_from: new Date('2026-01-01T00:00:00Z') });
  await seedTestSchedule({ user_id: emp.id, weekday: beirutWeekday(IN_1), shift_min: 480 });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: IN_1 });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: OUT_1 });
  return { branch, emp, admin };
}

async function workThreeHoursMore(userId: string, branchId: string) {
  await seedTestPunch({ user_id: userId, branch_id: branchId, kind: 'IN', at: IN_2 });
  await seedTestPunch({ user_id: userId, branch_id: branchId, kind: 'OUT', at: OUT_2 });
}

// `overtimeMin` is the figure the owner's screen was showing when they clicked.
// Pass it explicitly everywhere: which amount a ruling was made against is the
// whole subject of this file.
async function decide(
  session: { cookies: string; csrf: string },
  userId: string,
  date: string,
  decision: 'ACCEPTED' | 'REVOKED' | 'PENDING',
  overtimeMin?: number,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/admin/overtime/decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': idemKey(),
    },
    body: JSON.stringify(
      overtimeMin === undefined ? { userId, date, decision } : { userId, date, decision, overtimeMin },
    ),
  });
}

async function payrollRow(session: { cookies: string; csrf: string }, username: string): Promise<PayrollRow> {
  const res = await fetch(`${BASE_URL}/api/admin/payroll?month=${MONTH}`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { rows: PayrollRow[] } };
  expect(body.ok).toBe(true);
  const row = body.data.rows.find((r) => r.username === username);
  expect(row).toBeTruthy();
  return row!;
}

async function listedOvertime(session: { cookies: string; csrf: string }, userId: string): Promise<OvertimeItem[]> {
  const res = await fetch(`${BASE_URL}/api/admin/overtime?userId=${userId}&month=${MONTH}`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { overtime: OvertimeItem[] } };
  expect(body.ok).toBe(true);
  return body.data.overtime;
}

// pendingOvertimeNotices is what feeds the dashboard's attention queue. Called
// directly rather than through /api/admin/overview so the assertion does not
// depend on the day under test falling inside the dashboard's 7-day window.
async function pendingFor(userId: string, username: string) {
  return pendingOvertimeNotices([{ id: userId, username }], MONTH, getTestPrisma(), { since: DAY });
}

describe('an overtime decision does not expand to cover later work (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('deducts nothing and re-queues the day when the overtime grows after the ruling', async () => {
    const { branch, emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    // Session 1: the owner sees 120 minutes over and revokes $4.00.
    const queuedBefore = await pendingFor(emp.id, emp.username);
    expect(queuedBefore).toHaveLength(1);
    expect(queuedBefore[0]!.overtimeMin).toBe(OVER_1_MIN);
    expect((await decide(aSession, emp.id, DAY, 'REVOKED', OVER_1_MIN)).status).toBe(200);

    const revoked = await payrollRow(aSession, 'ots-emp');
    expect(revoked.gross_cent).toBe(GROSS_1_CENT);
    expect(revoked.overtime_deduction_cent).toBe(OVER_1_CENT);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);

    // Session 2: three more hours land on the same Beirut day. The single
    // decision row is keyed by the day, so it used to reapply to the new
    // total and take $10.00 the owner never agreed to.
    await workThreeHoursMore(emp.id, branch.id);

    expect(await overtimeDeductionForUser(emp.id, MONTH, getTestPrisma())).toBe(0);

    const after = await payrollRow(aSession, 'ots-emp');
    expect(after.gross_cent).toBe(GROSS_2_CENT);
    expect(after.overtime_deduction_cent).toBe(0);
    expect(after.net_cent).toBe(GROSS_2_CENT);

    // The stale row is still there - it is read as stale, not deleted.
    const stored = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.decision).toBe('REVOKED');
    expect(stored[0]!.overtime_min).toBe(OVER_1_MIN);

    // Back on the review queue at the full new amount, so the owner is asked
    // again rather than the old ruling quietly covering the new hours.
    const queuedAfter = await pendingFor(emp.id, emp.username);
    expect(queuedAfter).toHaveLength(1);
    expect(queuedAfter[0]!.date).toBe(DAY);
    expect(queuedAfter[0]!.overtimeMin).toBe(OVER_2_MIN);
    expect(queuedAfter[0]!.amount_cent).toBe(OVER_2_CENT);

    const listed = await listedOvertime(aSession, emp.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.overtimeMin).toBe(OVER_2_MIN);
    expect(listed[0]!.amount_cent).toBe(OVER_2_CENT);
    expect(listed[0]!.decision).toBeNull();
  });

  it('deducts the new amount once the owner rules on it again', async () => {
    const { branch, emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, DAY, 'REVOKED', OVER_1_MIN)).status).toBe(200);
    await workThreeHoursMore(emp.id, branch.id);

    // The owner is looking at the new figure now, and rules on that.
    expect((await decide(aSession, emp.id, DAY, 'REVOKED', OVER_2_MIN)).status).toBe(200);

    const rows = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.overtime_min).toBe(OVER_2_MIN);

    const after = await payrollRow(aSession, 'ots-emp');
    expect(after.overtime_deduction_cent).toBe(OVER_2_CENT);
    expect(after.net_cent).toBe(GROSS_2_CENT - OVER_2_CENT);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);
  });

  it('refuses a ruling made against an amount the day no longer has', async () => {
    // The modal does not poll. It renders 120 min / $4.00, a punch lands on
    // that day while it sits open, and the owner clicks Revoke on the row they
    // can see. Stamping "whatever the day is at click time" would quietly turn
    // that click into a $10.00 deduction.
    const { branch, emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const rendered = await listedOvertime(aSession, emp.id);
    expect(rendered[0]!.overtimeMin).toBe(OVER_1_MIN);
    expect(rendered[0]!.amount_cent).toBe(OVER_1_CENT);

    await workThreeHoursMore(emp.id, branch.id);

    const res = await decide(aSession, emp.id, DAY, 'REVOKED', rendered[0]!.overtimeMin);
    const body = (await res.json()) as { ok: boolean; error?: { code: string; message: string } };

    // Nothing stamped and nothing deducted - asserted first, because that is
    // the property that protects the employee's pay whatever the reply says.
    expect(await overtimeDeductionForUser(emp.id, MONTH, getTestPrisma())).toBe(0);
    expect((await payrollRow(aSession, 'ots-emp')).overtime_deduction_cent).toBe(0);
    expect(await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
    expect(
      await getTestPrisma().auditLog.findMany({
        where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:${DAY}` },
      }),
    ).toHaveLength(0);

    // And the owner is told why, with both figures.
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('OVERTIME_CHANGED');
    expect(body.error?.message).toContain('2h 0m');
    expect(body.error?.message).toContain('5h 0m');

    // Still waiting for a ruling, at the amount that is actually there.
    const queued = await pendingFor(emp.id, emp.username);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.overtimeMin).toBe(OVER_2_MIN);
  });

  it('lands the ruling once it names the figure the day actually has', async () => {
    const { branch, emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await workThreeHoursMore(emp.id, branch.id);

    expect((await decide(aSession, emp.id, DAY, 'REVOKED', OVER_2_MIN)).status).toBe(200);
    const rows = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.overtime_min).toBe(OVER_2_MIN);
    expect((await payrollRow(aSession, 'ots-emp')).overtime_deduction_cent).toBe(OVER_2_CENT);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:${DAY}`, action: 'overtime.revoked' },
    });
    expect(audit?.after_json).toMatchObject({ overtime_min: OVER_2_MIN });
  });

  it('refuses a money-moving ruling that names no amount at all', async () => {
    // Without the token there is nothing to confirm against, so a client must
    // not be able to opt out of the check by omitting it.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const res = await decide(aSession, emp.id, DAY, 'REVOKED');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
    expect(await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
  });

  it('still undoes a ruling: the row goes and the day returns to pending', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, DAY, 'REVOKED', OVER_1_MIN)).status).toBe(200);
    expect((await payrollRow(aSession, 'ots-emp')).overtime_deduction_cent).toBe(OVER_1_CENT);

    const undo = await decide(aSession, emp.id, DAY, 'PENDING');
    expect(undo.status).toBe(200);
    expect(await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } })).toHaveLength(0);

    const listed = await listedOvertime(aSession, emp.id);
    expect(listed[0]!.decision).toBeNull();
    expect((await payrollRow(aSession, 'ots-emp')).overtime_deduction_cent).toBe(0);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:${DAY}`, action: 'overtime.undecided' },
    });
    expect(audit?.before_json).toMatchObject({ decision: 'REVOKED', overtime_min: OVER_1_MIN });
  });

  it('treats a row written before the column existed as stale', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await getTestPrisma().overtimeDecision.create({
      data: {
        user_id: emp.id,
        date: new Date(`${DAY}T00:00:00.000Z`),
        decision: 'REVOKED',
        overtime_min: null,
        decided_by: admin.id,
      },
    });

    expect(await overtimeDeductionForUser(emp.id, MONTH, getTestPrisma())).toBe(0);
    expect((await payrollRow(aSession, 'ots-emp')).overtime_deduction_cent).toBe(0);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(1);
  });
});
