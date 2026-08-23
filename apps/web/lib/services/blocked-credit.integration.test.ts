import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { beirutWeekday, todayInBeirut, scheduledToUtc } from 'time';
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

// Anchored to yesterday, not a fixed July date. The attention queue only looks
// back 7 days, so a fixed past date made the notices filter match nothing and
// the assertions inside the loop never ran at all - the queue had no coverage.
const YESTERDAY = new Date(Date.now() - 24 * 3_600_000);
const DATE = todayInBeirut(YESTERDAY);
const MONTH = DATE.slice(0, 7);
// Beirut wall-clock times on that day.
const BLOCKED_AT = beirutAt(DATE, '06:00');
const IN_AT = beirutAt(DATE, '08:00');
const OUT_AT = beirutAt(DATE, '14:00'); // 360 min clocked
const RATE_CENT = 600; // $6.00/h
// 360 clocked + 120 credited = the full 480 shift. 480 x $6.00 = $48.00.
const GROSS_WITH_CREDIT_CENT = 4800;
const GROSS_WITHOUT_CREDIT_CENT = 3600;

function beirutAt(date: string, hhmm: string): Date {
  return scheduledToUtc(date, hhmm);
}

interface PayrollRow {
  username: string;
  gross_cent: number;
  blocked_credit_cent: number;
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

  async function decide(cookies: string, csrf: string, body: unknown) {
    return fetch(`${BASE_URL}/api/admin/blocked-credit/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idem('bc'),
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify(body),
    });
  }

  it('shows on the attention queue and moves no money until it is accepted', async () => {
    const { user } = await seedBlockedDay('bc-emp');
    const admin = await seedTestUser({ username: 'bc-admin', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const ovRes = await fetch(`${BASE_URL}/api/admin/overview`, { headers: { Cookie: a.cookies } });
    const ov = await ovRes.json();
    const notices = (ov.data.attention.blockedCredits as Array<{
      user_id: string;
      date: string;
      creditedMin: number;
      amount_cent: number;
    }>).filter((n) => n.user_id === user.id);
    // Not a filtered loop that can quietly match nothing: the row must be here.
    expect(notices).toHaveLength(1);
    expect(notices[0]!.date).toBe(DATE);
    expect(notices[0]!.creditedMin).toBe(120);
    expect(notices[0]!.amount_cent).toBe(1200);

    // Nothing paid, and the day still carries its full shortfall.
    const row = await payrollFor(user.username, a.cookies);
    expect(row.gross_cent).toBe(GROSS_WITHOUT_CREDIT_CENT);
    expect(row.blocked_credit_cent).toBe(0);
    // 240 docked minutes at $6.00/h, ceilinged by the day's own $36.00 gross.
    expect(row.penalties_cent).toBe(2400);
  });

  it('accepting pays the wait, clears the shortfall, and shows as its own line', async () => {
    const { user } = await seedBlockedDay('bc-emp-ok');
    const admin = await seedTestUser({ username: 'bc-admin-ok', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const res = await decide(a.cookies, a.csrf, { userId: user.id, date: DATE, decision: 'ACCEPTED', creditedMin: 120 });
    expect(res.status).toBe(200);

    const row = await payrollFor(user.username, a.cookies);
    expect(row.gross_cent).toBe(GROSS_WITH_CREDIT_CENT);
    // Inside gross, and named: 120 min at $6.00/h.
    expect(row.blocked_credit_cent).toBe(1200);
    expect(row.penalties_cent).toBe(0);
    expect(row.net_cent).toBe(GROSS_WITH_CREDIT_CENT);

    const penRes = await fetch(`${BASE_URL}/api/admin/penalties?userId=${user.id}&month=${MONTH}`, {
      headers: { Cookie: a.cookies },
    });
    expect((await penRes.json()).data.penalties).toEqual([]);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'BlockedCreditDecision', entity_id: `${user.id}:${DATE}` },
    });
    expect(audit?.action).toBe('blocked_credit.accepted');
  });

  it('revoking changes no money, because nothing had been credited', async () => {
    const { user } = await seedBlockedDay('bc-emp2');
    const admin = await seedTestUser({ username: 'bc-admin2', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    const before = await payrollFor(user.username, a.cookies);
    const res = await decide(a.cookies, a.csrf, { userId: user.id, date: DATE, decision: 'REVOKED', creditedMin: 120 });
    expect(res.status).toBe(200);

    const after = await payrollFor(user.username, a.cookies);
    expect(after.gross_cent).toBe(before.gross_cent);
    expect(after.net_cent).toBe(before.net_cent);
    expect(after.gross_cent).toBe(GROSS_WITHOUT_CREDIT_CENT);
    expect(after.penalties_cent).toBe(2400);

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

  it('undo takes back a mis-clicked acceptance and puts the day back on the queue', async () => {
    const { user } = await seedBlockedDay('bc-emp4');
    const admin = await seedTestUser({ username: 'bc-admin4', role: Role.ADMIN });
    const a = await loginAs(admin.username, 'change-me');

    expect((await decide(a.cookies, a.csrf, { userId: user.id, date: DATE, decision: 'ACCEPTED', creditedMin: 120 })).status).toBe(200);
    expect((await payrollFor(user.username, a.cookies)).gross_cent).toBe(GROSS_WITH_CREDIT_CENT);

    expect((await decide(a.cookies, a.csrf, { userId: user.id, date: DATE, decision: 'PENDING' })).status).toBe(200);
    expect((await payrollFor(user.username, a.cookies)).gross_cent).toBe(GROSS_WITHOUT_CREDIT_CENT);

    const ov = await (await fetch(`${BASE_URL}/api/admin/overview`, { headers: { Cookie: a.cookies } })).json();
    expect(
      (ov.data.attention.blockedCredits as Array<{ user_id: string }>).filter((n) => n.user_id === user.id),
    ).toHaveLength(1);
  });
});
