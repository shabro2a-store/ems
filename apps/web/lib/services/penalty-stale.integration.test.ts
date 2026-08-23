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
import { pendingPenaltyNotices } from './penalty';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

const MONTH = '2026-07';
const DAY = '2026-07-01';
const RATE_CENT = 200; // $2.00/h
const SHIFT_MIN = 480;

// Beirut 08:00-14:00: 360 of 480 minutes, 120 short. Doubled = 240 docked, $8.00.
const IN_AT = new Date('2026-07-01T05:00:00Z');
const OUT_AT = new Date('2026-07-01T11:00:00Z');
// The owner corrects the checkout to 13:00: 300 worked, 180 short. Doubling says
// 360, the ceiling says 300, so 300 docked - $10.00.
const OUT_CORRECTED = new Date('2026-07-01T10:00:00Z');

// The owner's worst case, and the one that would have shipped: a 30-minute
// shortfall waived, then a correction that turns the day into a 4-hour one.
// Out 15:30 Beirut: 450 worked, 30 short -> 60 docked, $2.00.
const OUT_SMALL = new Date('2026-07-01T12:30:00Z');
// Out 12:00 Beirut: 240 worked, 240 short -> ceilinged to 240 docked, $8.00.
const OUT_BIG = new Date('2026-07-01T09:00:00Z');
const SMALL_MIN = 60;
const SMALL_CENT = 200;
const BIG_MIN = 240;
const BIG_CENT = 800;

const PEN_1_MIN = 240;
const PEN_1_CENT = 800; // what the owner actually ruled on
const PEN_2_MIN = 300;
const PEN_2_CENT = 1000; // what a stale ruling used to cover in silence
const GROSS_1_CENT = 1200;
const GROSS_2_CENT = 1000;

interface PayrollRow {
  username: string;
  gross_cent: number;
  penalties_cent: number;
  net_cent: number;
}

interface PenaltyRow {
  date: string;
  kind: 'SHORTFALL';
  shortfallMin: number;
  penaltyMin: number;
  amount_cent: number;
  waived: boolean;
  waiverStale: boolean;
}

async function setup() {
  const branch = await seedTestBranch({ name: 'Hamra', shift_grace_min: 15 });
  const emp = await seedTestUser({ username: 'pns-emp', branch_id: branch.id, hourly_rate_cent: RATE_CENT });
  const admin = await seedTestUser({ username: 'pns-admin', role: Role.ADMIN });
  // seedTestUser's own RateChange starts "now", which is after the month under
  // test, so July would price at zero without this.
  await seedTestRateChange({ user_id: emp.id, rate_cent: RATE_CENT, effective_from: new Date('2026-01-01T00:00:00Z') });
  await seedTestSchedule({ user_id: emp.id, weekday: beirutWeekday(IN_AT), shift_min: SHIFT_MIN });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: IN_AT });
  await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: OUT_AT });
  return { branch, emp, admin };
}

// The owner corrects a punch by hand, which is routine here and is exactly what
// moves a day out from under a ruling already made on it.
async function setCheckout(userId: string, at: Date) {
  const db = getTestPrisma();
  const out = await db.punch.findFirst({ where: { user_id: userId, kind: 'OUT' }, orderBy: { at: 'desc' } });
  await db.punch.update({
    where: { id: out!.id },
    data: { at, corrected: true, correction_reason: 'left earlier than punched' },
  });
}

async function correctTheCheckout(userId: string) {
  await setCheckout(userId, OUT_CORRECTED);
}

function headersFor(session: { cookies: string; csrf: string }) {
  return {
    'Content-Type': 'application/json',
    Cookie: session.cookies,
    'X-CSRF-Token': session.csrf,
  };
}

// `penaltyMin` is the figure the owner's screen was showing when they clicked.
// Passed explicitly everywhere: which amount a ruling was made against is the
// whole subject of this file.
async function ack(
  session: { cookies: string; csrf: string },
  userId: string,
  penaltyMin?: number,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/admin/penalties/ack`, {
    method: 'POST',
    headers: headersFor(session),
    body: JSON.stringify(
      penaltyMin === undefined
        ? { userId, date: DAY, kind: 'SHORTFALL' }
        : { userId, date: DAY, kind: 'SHORTFALL', penaltyMin },
    ),
  });
}

async function waive(
  session: { cookies: string; csrf: string },
  userId: string,
  waived: boolean,
  penaltyMin: number,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/admin/penalties/waive`, {
    method: 'POST',
    headers: headersFor(session),
    body: JSON.stringify({ userId, date: DAY, kind: 'SHORTFALL', waived, penaltyMin }),
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

async function listedPenalties(session: { cookies: string; csrf: string }, userId: string): Promise<PenaltyRow[]> {
  const res = await fetch(`${BASE_URL}/api/admin/penalties?userId=${userId}&month=${MONTH}`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { penalties: PenaltyRow[] } };
  expect(body.ok).toBe(true);
  return body.data.penalties;
}

// pendingPenaltyNotices is what feeds the dashboard's attention queue. Called
// directly rather than through /api/admin/overview so the assertion does not
// depend on the day under test falling inside the dashboard's 7-day window.
async function pendingFor(userId: string, username: string) {
  return pendingPenaltyNotices([{ id: userId, username }], MONTH, getTestPrisma(), { since: DAY });
}

describe('a penalty ruling does not cover an amount the day no longer has (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('starts from a penalty the owner has not seen yet', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const listed = await listedPenalties(aSession, emp.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.shortfallMin).toBe(120);
    expect(listed[0]!.penaltyMin).toBe(PEN_1_MIN);
    expect(listed[0]!.amount_cent).toBe(PEN_1_CENT);

    const row = await payrollRow(aSession, 'pns-emp');
    expect(row.gross_cent).toBe(GROSS_1_CENT);
    expect(row.penalties_cent).toBe(PEN_1_CENT);

    const queued = await pendingFor(emp.id, emp.username);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.penaltyMin).toBe(PEN_1_MIN);
  });

  it('re-queues an acknowledged day at the new figure once a correction moves it', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    // The owner sees 240 docked minutes / $8.00 and lets it stand.
    expect((await ack(aSession, emp.id, PEN_1_MIN)).status).toBe(200);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);
    expect(await getTestPrisma().penaltyAck.findMany({ where: { user_id: emp.id } })).toHaveLength(1);

    await correctTheCheckout(emp.id);

    // The penalty is now $10.00. The old ack said $8.00 stands, and it must not
    // be read as saying this one does: the day is back in front of the owner.
    const queued = await pendingFor(emp.id, emp.username);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.penaltyMin).toBe(PEN_2_MIN);
    expect(queued[0]!.amount_cent).toBe(PEN_2_CENT);

    const row = await payrollRow(aSession, 'pns-emp');
    expect(row.gross_cent).toBe(GROSS_2_CENT);
    expect(row.penalties_cent).toBe(PEN_2_CENT);
  });

  it('keeps forgiving a grown shortfall and puts the day back for review', async () => {
    // The case that would have shipped. $2.00 removed, then a correction turns
    // the day into a $8.00 one. Docking that would take back money the owner
    // had already decided to give, on an amount he has never seen.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await setCheckout(emp.id, OUT_SMALL);

    const before = await listedPenalties(aSession, emp.id);
    expect(before[0]!.penaltyMin).toBe(SMALL_MIN);
    expect(before[0]!.amount_cent).toBe(SMALL_CENT);
    expect((await waive(aSession, emp.id, true, SMALL_MIN)).status).toBe(200);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);

    await setCheckout(emp.id, OUT_BIG);

    // Money first: nothing is docked, and that is the whole point.
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);

    const listed = await listedPenalties(aSession, emp.id);
    expect(listed[0]!.penaltyMin).toBe(BIG_MIN);
    expect(listed[0]!.amount_cent).toBe(BIG_CENT);
    expect(listed[0]!.waived).toBe(true);
    expect(listed[0]!.waiverStale).toBe(true);

    // And the owner is asked about the new figure.
    const queued = await pendingFor(emp.id, emp.username);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.penaltyMin).toBe(BIG_MIN);
    expect(queued[0]!.amount_cent).toBe(BIG_CENT);
    expect(queued[0]!.waived).toBe(true);
  });

  it('leaves the queue once the removal is confirmed at the new figure, still docking nothing', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await setCheckout(emp.id, OUT_SMALL);
    expect((await waive(aSession, emp.id, true, SMALL_MIN)).status).toBe(200);
    await setCheckout(emp.id, OUT_BIG);

    expect((await waive(aSession, emp.id, true, BIG_MIN)).status).toBe(200);

    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);
    const listed = await listedPenalties(aSession, emp.id);
    expect(listed[0]!.waived).toBe(true);
    expect(listed[0]!.waiverStale).toBe(false);
    const rows = await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.penalty_min).toBe(BIG_MIN);
  });

  it('applies the penalty at the new figure when the owner accepts it instead', async () => {
    // Accept means "this penalty stands", which is the opposite of a removal -
    // so the waiver goes, and only then does money start moving.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await setCheckout(emp.id, OUT_SMALL);
    expect((await waive(aSession, emp.id, true, SMALL_MIN)).status).toBe(200);
    await setCheckout(emp.id, OUT_BIG);

    expect((await ack(aSession, emp.id, BIG_MIN)).status).toBe(200);

    expect(await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(BIG_CENT);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);
    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'PenaltyAck', entity_id: `${emp.id}:${DAY}:SHORTFALL`, action: 'penalty.acknowledge' },
    });
    expect(audit?.after_json).toMatchObject({ penalty_min: BIG_MIN, cleared_waiver: true });
  });

  it('keeps forgiving on a waiver that recorded no amount, and still asks about it', async () => {
    // Any row written before penalty_min existed. It names no figure so it can
    // never match - but it is still the owner's removal, so the money stays
    // where he put it and no backfill is needed.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await waive(aSession, emp.id, true, PEN_1_MIN)).status).toBe(200);
    await getTestPrisma().penaltyWaiver.updateMany({ where: { user_id: emp.id }, data: { penalty_min: null } });

    const listed = await listedPenalties(aSession, emp.id);
    expect(listed[0]!.waived).toBe(true);
    expect(listed[0]!.waiverStale).toBe(true);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);
    expect((await pendingFor(emp.id, emp.username))[0]!.penaltyMin).toBe(PEN_1_MIN);
  });

  it('treats an ack that recorded no amount as unreviewed', async () => {
    // An ack moves no money, so here the pre-column row simply returns the day
    // to the queue - and the automatic penalty was applying all along.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await ack(aSession, emp.id, PEN_1_MIN)).status).toBe(200);
    await getTestPrisma().penaltyAck.updateMany({ where: { user_id: emp.id }, data: { penalty_min: null } });

    expect((await listedPenalties(aSession, emp.id))[0]!.waived).toBe(false);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(PEN_1_CENT);
    expect((await pendingFor(emp.id, emp.username))[0]!.penaltyMin).toBe(PEN_1_MIN);
  });

  it('refuses a ruling made against an amount the day no longer has', async () => {
    // Neither screen polls. The row renders 240 min / $8.00, the owner corrects
    // the punch in another tab, then clicks Accept on the row they can see.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const rendered = await listedPenalties(aSession, emp.id);
    expect(rendered[0]!.penaltyMin).toBe(PEN_1_MIN);

    await correctTheCheckout(emp.id);

    const res = await ack(aSession, emp.id, rendered[0]!.penaltyMin);
    const body = (await res.json()) as { ok: boolean; error?: { code: string; message: string } };

    // Nothing written - asserted first, because that is the property that keeps
    // the owner's click from meaning more than they could see.
    expect(await getTestPrisma().penaltyAck.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
    expect(
      await getTestPrisma().auditLog.findMany({
        where: { entity: 'PenaltyAck', entity_id: `${emp.id}:${DAY}:SHORTFALL` },
      }),
    ).toHaveLength(0);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('PENALTY_CHANGED');
    expect(body.error?.message).toContain('4h 0m');
    expect(body.error?.message).toContain('5h 0m');

    // Still waiting for a ruling, at the amount that is actually there.
    const queued = await pendingFor(emp.id, emp.username);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.penaltyMin).toBe(PEN_2_MIN);
  });

  it('refuses a waiver made against an amount the day no longer has', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await correctTheCheckout(emp.id);

    const res = await waive(aSession, emp.id, true, PEN_1_MIN);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('PENALTY_CHANGED');
    expect(await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(PEN_2_CENT);
  });

  it('cannot start a deduction by refusing a restore', async () => {
    // The refusal writes nothing and deletes nothing, so the removal the owner
    // granted is still standing on the other side of it. A guard that dropped
    // the waiver on its way to saying no would be worse than no guard.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await setCheckout(emp.id, OUT_SMALL);
    expect((await waive(aSession, emp.id, true, SMALL_MIN)).status).toBe(200);
    await setCheckout(emp.id, OUT_BIG);

    // The screen still shows the old figure, and the owner clicks Restore.
    const res = await waive(aSession, emp.id, false, SMALL_MIN);
    expect(res.status).toBe(409);
    expect(await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } })).toHaveLength(1);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);
  });

  it('refuses a ruling that names no amount at all', async () => {
    // Without the token there is nothing to confirm against, so a client must
    // not be able to opt out of the check by omitting it.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const res = await ack(aSession, emp.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
    expect(await getTestPrisma().penaltyAck.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
  });

  it('lands the ruling once it names the figure the day actually has', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    await correctTheCheckout(emp.id);

    expect((await ack(aSession, emp.id, PEN_2_MIN)).status).toBe(200);

    const rows = await getTestPrisma().penaltyAck.findMany({ where: { user_id: emp.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.penalty_min).toBe(PEN_2_MIN);
    expect(await pendingFor(emp.id, emp.username)).toHaveLength(0);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'PenaltyAck', entity_id: `${emp.id}:${DAY}:SHORTFALL`, action: 'penalty.acknowledge' },
    });
    expect(audit?.after_json).toMatchObject({ penalty_min: PEN_2_MIN });
  });

  it('stamps the server figure, not whatever the client claims the day is worth', async () => {
    // The body's number is a comparison token. It has to match, and having
    // matched it is discarded - the row records what the server computed.
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/penalties/waive`, {
      method: 'POST',
      headers: headersFor(aSession),
      body: JSON.stringify({
        userId: emp.id,
        date: DAY,
        kind: 'SHORTFALL',
        waived: true,
        penaltyMin: PEN_1_MIN,
        penalty_min: PEN_2_MIN,
      }),
    });
    expect(res.status).toBe(200);
    const rows = await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } });
    expect(rows[0]!.penalty_min).toBe(PEN_1_MIN);
  });

  it('still restores a penalty, and re-queues the day when it does', async () => {
    const { emp, admin } = await setup();
    const aSession = await loginAs(admin.username, 'change-me');
    expect((await waive(aSession, emp.id, true, PEN_1_MIN)).status).toBe(200);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(0);

    expect((await waive(aSession, emp.id, false, PEN_1_MIN)).status).toBe(200);
    expect(await getTestPrisma().penaltyWaiver.findMany({ where: { user_id: emp.id } })).toHaveLength(0);
    expect((await payrollRow(aSession, 'pns-emp')).penalties_cent).toBe(PEN_1_CENT);
    expect((await pendingFor(emp.id, emp.username))[0]!.penaltyMin).toBe(PEN_1_MIN);
  });
});
