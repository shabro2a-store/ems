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

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

const MONTH = '2026-07';
const IN_AT = new Date('2026-07-01T05:00:00Z'); // Beirut 08:00
const OUT_AT = new Date('2026-07-01T15:00:00Z'); // Beirut 18:00, 600 min worked
const RATE_CENT = 600;
// 600 worked against a 480 shift is 120 min over, past the branch's 15 min
// grace. Overtime is already inside gross, so revoking it deducts that hour's
// worth: floor(120 * 600 / 60) = 1200.
const GROSS_CENT = 6000;
const OVERTIME_CENT = 1200;

interface PayrollRow {
  username: string;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
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
  return `otp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setup() {
  const branch = await seedTestBranch({ name: 'Hamra', overtime_grace_min: 15 });
  const emp = await seedTestUser({ username: 'otp-emp', branch_id: branch.id, hourly_rate_cent: RATE_CENT });
  const admin = await seedTestUser({ username: 'otp-admin', role: Role.ADMIN });
  // seedTestUser's own RateChange starts "now", which is after the month under
  // test, so July would price at zero without this.
  await seedTestRateChange({ user_id: emp.id, rate_cent: RATE_CENT, effective_from: new Date('2026-01-01T00:00:00Z') });
  await seedTestSchedule({ user_id: emp.id, weekday: beirutWeekday(IN_AT), shift_min: 480 });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: IN_AT });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: OUT_AT });
  return { branch, emp, admin };
}

async function adminPayrollRow(session: { cookies: string; csrf: string }, username: string): Promise<PayrollRow> {
  const res = await fetch(`${BASE_URL}/api/admin/payroll?month=${MONTH}`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { rows: PayrollRow[]; totals: PayrollRow } };
  expect(body.ok).toBe(true);
  const row = body.data.rows.find((r) => r.username === username);
  expect(row).toBeTruthy();
  return row!;
}

async function decide(
  session: { cookies: string; csrf: string },
  userId: string,
  date: string,
  decision: 'ACCEPTED' | 'REVOKED' | 'PENDING',
  // The amount the screen was showing. The route refuses a ruling that names a
  // figure the day no longer has; every day in this file is the 120-min one.
  overtimeMin = 120,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/admin/overtime/decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': idemKey(),
    },
    body: JSON.stringify({ userId, date, decision, overtimeMin }),
  });
}

describe('revoked overtime on the payroll surfaces (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('shows the deduction as its own line on the admin table, and the row still adds up', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const before = await adminPayrollRow(aSession, 'otp-emp');
    expect(before.gross_cent).toBe(GROSS_CENT);
    expect(before.overtime_deduction_cent).toBe(0);
    expect(before.net_cent).toBe(GROSS_CENT);

    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);

    const after = await adminPayrollRow(aSession, 'otp-emp');
    expect(after.overtime_deduction_cent).toBe(OVERTIME_CENT);
    expect(after.net_cent).toBe(GROSS_CENT - OVERTIME_CENT);
    // The defect was net dropping with no column accounting for it, so the
    // reconciliation is the assertion that matters.
    expect(
      after.gross_cent +
        after.adjustments_cent -
        after.advances_cent -
        after.penalties_cent -
        after.overtime_deduction_cent,
    ).toBe(after.net_cent);
  });

  it('totals the deduction across the table', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);

    const res = await fetch(`${BASE_URL}/api/admin/payroll?month=${MONTH}`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    const body = (await res.json()) as { data: { totals: PayrollRow } };
    expect(body.data.totals.overtime_deduction_cent).toBe(OVERTIME_CENT);
  });

  it('shows the employee why their take-home dropped', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);

    const eSession = await loginAs(emp.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/me/payroll?month=${MONTH}`, {
      headers: { Cookie: eSession.cookies, 'X-CSRF-Token': eSession.csrf },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: PayrollRow };
    expect(body.ok).toBe(true);
    expect(body.data.overtime_deduction_cent).toBe(OVERTIME_CENT);
    expect(body.data.net_cent).toBe(GROSS_CENT - OVERTIME_CENT);
    expect(
      body.data.gross_cent +
        body.data.adjustments_cent -
        body.data.advances_cent -
        body.data.penalties_cent -
        body.data.overtime_deduction_cent,
    ).toBe(body.data.net_cent);
  });

  it('lists a decided day so it can still be found after it leaves the queue', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);

    const res = await fetch(`${BASE_URL}/api/admin/overtime?userId=${emp.id}&month=${MONTH}`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { overtime: OvertimeItem[] } };
    expect(body.ok).toBe(true);
    expect(body.data.overtime).toHaveLength(1);
    expect(body.data.overtime[0]!.date).toBe('2026-07-01');
    expect(body.data.overtime[0]!.overtimeMin).toBe(120);
    expect(body.data.overtime[0]!.amount_cent).toBe(OVERTIME_CENT);
    expect(body.data.overtime[0]!.decision).toBe('REVOKED');
  });

  it('undoes a mis-clicked Revoke: the day goes back to pending and the pay comes back', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);
    expect((await adminPayrollRow(aSession, 'otp-emp')).overtime_deduction_cent).toBe(OVERTIME_CENT);

    const undo = await decide(aSession, emp.id, '2026-07-01', 'PENDING');
    expect(undo.status).toBe(200);
    expect((await undo.json()).data).toEqual({ decision: 'PENDING' });

    // Pending is the absence of a row, so the undo has to delete it - anything
    // left behind keeps the day off the attention queue.
    const rows = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(0);

    const listed = await fetch(`${BASE_URL}/api/admin/overtime?userId=${emp.id}&month=${MONTH}`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    const listedBody = (await listed.json()) as { data: { overtime: OvertimeItem[] } };
    expect(listedBody.data.overtime[0]!.decision).toBeNull();

    const after = await adminPayrollRow(aSession, 'otp-emp');
    expect(after.overtime_deduction_cent).toBe(0);
    expect(after.net_cent).toBe(GROSS_CENT);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:2026-07-01`, action: 'overtime.undecided' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor_id).toBe(admin.id);
    expect(audit?.before_json).toMatchObject({ decision: 'REVOKED' });
  });

  it('refuses the undo to a non-admin', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await decide(aSession, emp.id, '2026-07-01', 'REVOKED')).status).toBe(200);

    const eSession = await loginAs(emp.username, 'change-me');
    const res = await decide(eSession, emp.id, '2026-07-01', 'PENDING');
    expect(res.status).toBe(403);
    const rows = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(1);
  });
});
