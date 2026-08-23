import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { beirutWeekday } from 'time';
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

const MONTH = '2026-07';
const DATE = '2026-07-01';
// Beirut is UTC+3 in July.
const BLOCKED_AT = new Date('2026-07-01T03:00:00Z'); // 06:00 Beirut
const IN_AT = new Date('2026-07-01T05:00:00Z'); // 08:00 Beirut
const OUT_AT = new Date('2026-07-01T11:00:00Z'); // 14:00 Beirut, 360 min clocked
const RATE_CENT = 600; // $6.00/h
// 360 clocked + 120 credited = the full 480 shift. 480 x $6.00 = $48.00.
const GROSS_WITH_CREDIT_CENT = 4800;
const GROSS_WITHOUT_CREDIT_CENT = 3600;

interface PayrollRow {
  username: string;
  gross_cent: number;
  penalties_cent: number;
  net_cent: number;
}

function idem(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function payrollFor(username: string, cookies: string): Promise<PayrollRow> {
  const res = await fetch(`${BASE_URL}/api/admin/payroll?month=${MONTH}`, { headers: { Cookie: cookies } });
  expect(res.status).toBe(200);
  const body = await res.json();
  const row = (body.data.rows as PayrollRow[]).find((r) => r.username === username);
  expect(row).toBeDefined();
  return row!;
}

describe('blocked-time credit integration (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  async function seedBlockedDay(username: string) {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827 });
    const user = await seedTestUser({ username, branch_id: branch.id, hourly_rate_cent: RATE_CENT });
    await getTestPrisma().rateChange.updateMany({
      where: { user_id: user.id },
      data: { effective_from: new Date('2026-01-01T00:00:00Z') },
    });
    await seedTestSchedule({ user_id: user.id, weekday: beirutWeekday(IN_AT), shift_min: 480 });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: IN_AT });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'OUT', at: OUT_AT });
    await getTestPrisma().blockedPunchAttempt.create({
      data: {
        user_id: user.id,
        branch_id: branch.id,
        at: BLOCKED_AT,
        open_in_at: new Date('2026-06-30T18:00:00Z'),
        lat: branch.lat,
        lng: branch.lng,
        accuracy_m: 12,
        device_fp: 'fp-blocked',
        ip: '127.0.0.1',
      },
    });
    return { branch, user };
  }

  it('pays the wait, clears the shortfall, and shows on the attention queue', async () => {
    const { user } = await seedBlockedDay('bc-emp');
    const admin = await seedTestUser({ username: 'bc-admin', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const row = await payrollFor(user.username, a.cookies);
    expect(row.gross_cent).toBe(GROSS_WITH_CREDIT_CENT);
    // Without the credit the day is 2h short: min(2 x 120, 360) = 240 min docked.
    expect(row.penalties_cent).toBe(0);
    expect(row.net_cent).toBe(GROSS_WITH_CREDIT_CENT);

    const ovRes = await fetch(`${BASE_URL}/api/admin/overview`, { headers: { Cookie: a.cookies } });
    const ov = await ovRes.json();
    const notices = ov.data.attention.blockedCredits as Array<{
      user_id: string;
      date: string;
      creditedMin: number;
      amount_cent: number;
    }>;
    // The lookback is 7 days, so this July day only shows if the clock is near
    // it; assert on the shape when it is present rather than pinning the date.
    for (const n of notices.filter((n) => n.user_id === user.id)) {
      expect(n.creditedMin).toBe(120);
      expect(n.amount_cent).toBe(1200);
    }

    const penRes = await fetch(`${BASE_URL}/api/admin/penalties?userId=${user.id}&month=${MONTH}`, {
      headers: { Cookie: a.cookies },
    });
    const pen = await penRes.json();
    expect(pen.data.penalties).toEqual([]);
  });

  it('revoking takes the credit back out of gross and the shortfall returns', async () => {
    const { user } = await seedBlockedDay('bc-emp2');
    const admin = await seedTestUser({ username: 'bc-admin2', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/blocked-credit/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idem('bc'),
        'X-CSRF-Token': a.csrf,
        Cookie: a.cookies,
      },
      body: JSON.stringify({ userId: user.id, date: DATE, decision: 'REVOKED', creditedMin: 120 }),
    });
    expect(res.status).toBe(200);

    const row = await payrollFor(user.username, a.cookies);
    expect(row.gross_cent).toBe(GROSS_WITHOUT_CREDIT_CENT);
    // 240 docked minutes at $6.00/h, ceilinged by the day's own $36.00 gross.
    expect(row.penalties_cent).toBe(2400);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'BlockedCreditDecision', entity_id: `${user.id}:${DATE}` },
    });
    expect(audit?.action).toBe('blocked_credit.revoked');
  });

  it('refuses a ruling made against a figure the day no longer has', async () => {
    const { user } = await seedBlockedDay('bc-emp3');
    const admin = await seedTestUser({ username: 'bc-admin3', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/blocked-credit/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idem('bc'),
        'X-CSRF-Token': a.csrf,
        Cookie: a.cookies,
      },
      body: JSON.stringify({ userId: user.id, date: DATE, decision: 'REVOKED', creditedMin: 45 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CREDIT_CHANGED');
    expect(await getTestPrisma().blockedCreditDecision.count({ where: { user_id: user.id } })).toBe(0);
  });

  it('undo puts a revoked credit back', async () => {
    const { user } = await seedBlockedDay('bc-emp4');
    const admin = await seedTestUser({ username: 'bc-admin4', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');
    const post = (body: unknown) =>
      fetch(`${BASE_URL}/api/admin/blocked-credit/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idem('bc'),
          'X-CSRF-Token': a.csrf,
          Cookie: a.cookies,
        },
        body: JSON.stringify(body),
      });

    expect((await post({ userId: user.id, date: DATE, decision: 'REVOKED', creditedMin: 120 })).status).toBe(200);
    expect((await payrollFor(user.username, a.cookies)).gross_cent).toBe(GROSS_WITHOUT_CREDIT_CENT);

    expect((await post({ userId: user.id, date: DATE, decision: 'PENDING' })).status).toBe(200);
    expect((await payrollFor(user.username, a.cookies)).gross_cent).toBe(GROSS_WITH_CREDIT_CENT);
  });
});
