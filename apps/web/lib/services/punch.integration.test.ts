import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { todayInBeirut } from 'time';
import { Role } from '@prisma/client';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedDayOffOverride,
  seedTestPunch,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('punch integration (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('Check 5: writes all 5 evidence fields per punch', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c5', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c5-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c5' }),
    });
    expect(res.status).toBe(200);

    const punch = await getTestPrisma().punch.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });
    expect(punch).not.toBeNull();
    expect(punch?.lat).toBe(33.89621);
    expect(punch?.lng).toBe(35.48271);
    expect(punch?.accuracy_m).toBe(12);
    expect(punch?.device_fp).toBe('test-fp-c5');
    expect(punch?.ip).toBeTruthy();
    expect(punch?.ip).not.toBe('');
  });

  it('Check 6: audit log entry per punch', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c6', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c6-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c6' }),
    });
    expect(res.status).toBe(200);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'Punch', actor_id: user.id },
      orderBy: { at: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.action).toBe('punch.create');
    expect(audit?.entity).toBe('Punch');
    expect(audit?.entity_id).toBeTruthy();

    const punch = await getTestPrisma().punch.findFirst({ where: { user_id: user.id } });
    expect(audit?.entity_id).toBe(punch?.id);
  });

  it('Check 7: idempotency-Key returns cached response on replay', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c7', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');
    const key = `c7-${Date.now()}-${Math.random()}`;
    const body = JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c7' });

    const r1 = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body,
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();

    const r2 = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body,
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();

    expect(j2).toEqual(j1);

    const stored = await getTestPrisma().idempotencyKey.findUnique({
      where: { key_user_id: { key, user_id: user.id } },
    });
    expect(stored).not.toBeNull();
    expect(stored?.status_code).toBe(200);

    const punchCount = await getTestPrisma().punch.count({ where: { user_id: user.id } });
    expect(punchCount).toBe(1);
  });

  it('Check 8: 6th rapid punch attempt returns 429', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c8', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const key = `c8-${Date.now()}-${i}-${Math.random()}`;
      const body = JSON.stringify({ kind: i === 0 ? 'IN' : 'OUT', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c8' });
      const r = await fetch(`${BASE_URL}/api/me/punch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-CSRF-Token': csrf,
          Cookie: cookies,
        },
        body,
      });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('Check 9: geofence rejection (outside radius)', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 50 });
    const user = await seedTestUser({ username: 'emp-c9', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c9-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.8895, lng: 35.5163, accuracy: 12, deviceFp: 'test-fp-c9' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('OUT_OF_GEOFENCE');
  });

  it('Check 10: low GPS accuracy rejected', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200, gps_accuracy_max_m: 100 });
    const user = await seedTestUser({ username: 'emp-c10', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c10-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 150, deviceFp: 'test-fp-c10' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('LOW_GPS_ACCURACY');
  });

  it('Check 11: /api/admin/now returns presence per branch', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const employee = await seedTestUser({ username: 'emp-c11', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'admin-c11', role: Role.ADMIN });

    const eSession = await loginAs(employee.username, 'change-me');
    const inRes = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c11-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': eSession.csrf,
        Cookie: eSession.cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c11' }),
    });
    expect(inRes.status).toBe(200);

    const aSession = await loginAs(admin.username, 'change-me');
    const nowRes = await fetch(`${BASE_URL}/api/admin/now`, {
      method: 'GET',
      headers: {
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
    });
    expect(nowRes.status).toBe(200);
    const body = await nowRes.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.branches)).toBe(true);
    expect(Array.isArray(body.data.flags)).toBe(true);
    expect(body.data.flags).toEqual([]);

    const hamra = body.data.branches.find((b: { name: string }) => b.name === 'Hamra');
    expect(hamra).toBeTruthy();
    const presentIds = (hamra.present as Array<{ id: string }>).map((p) => p.id);
    expect(presentIds).toContain(employee.id);
    expect(Array.isArray(hamra.driversOut)).toBe(true);
    expect(hamra.driversOut).toEqual([]);
  });

  it('Check 12: /api/me/today returns current session', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c12', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const inRes = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c12-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c12' }),
    });
    expect(inRes.status).toBe(200);

    const todayRes = await fetch(`${BASE_URL}/api/me/today`, {
      method: 'GET',
      headers: {
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
    });
    expect(todayRes.status).toBe(200);
    const body = await todayRes.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.in_at).toBe('string');
    expect(Number.isInteger(body.data.minutes_since_in)).toBe(true);
    expect(body.data.minutes_since_in).toBeGreaterThanOrEqual(0);
  });

  it('/api/me/today carries hours only — no money fields, and hours_month excludes the open session', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-hrs', branch_id: branch.id });
    const month = todayInBeirut(new Date()).slice(0, 7);
    // A completed 8h shift earlier this month — anchored to day 1 so it is
    // always in the past relative to "now", whatever day the suite runs on.
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date(`${month}-01T04:00:00.000Z`) });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'OUT', at: new Date(`${month}-01T12:00:00.000Z`) });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    // Punch in today too, so the test also proves an open session does not
    // inflate hours_month (same basis the old earned_month_cent used).
    const inRes = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `hrs-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-hrs' }),
    });
    expect(inRes.status).toBe(200);

    const res = await fetch(`${BASE_URL}/api/me/today`, {
      headers: { Cookie: cookies, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Exact key set: catches a stray money field left in, as much as one dropped.
    expect(Object.keys(body.data).sort()).toEqual(['hours_month', 'in_at', 'minutes_since_in', 'minutes_today']);
    expect(typeof body.data.in_at).toBe('string');
    expect(body.data.minutes_since_in).toBeGreaterThanOrEqual(0);
    expect(body.data.hours_month).toBe(8);
    expect(body.data.earned_today_cent).toBeUndefined();
    expect(body.data.earned_month_cent).toBeUndefined();
    expect(body.data.approved_advance_balance_cent).toBeUndefined();
    expect(body.data.net_cent).toBeUndefined();
  });

  it('Check 13: day-off override does NOT block punching (staff may help on a day off)', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-c13', branch_id: branch.id });
    const today = new Date(`${todayInBeirut(new Date())}T00:00:00.000Z`);
    await seedDayOffOverride(user.id, today);
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c13-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-c13' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('Check 14: server-side geofence bypass test (high accuracy rejected)', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200, gps_accuracy_max_m: 100 });
    const user = await seedTestUser({ username: 'emp-c14', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `c14-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 200, deviceFp: 'test-fp-c14' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('LOW_GPS_ACCURACY');

    const punchCount = await getTestPrisma().punch.count({ where: { user_id: user.id } });
    expect(punchCount).toBe(0);
  });

  it('a blocked check-in explains itself and is recorded as evidence', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const user = await seedTestUser({ username: 'emp-blocked', branch_id: branch.id });
    // Yesterday evening's check-in, never closed.
    const openAt = new Date(Date.now() - 14 * 3_600_000);
    await seedTestPunch({ user_id: user.id, branch_id: branch.id, kind: 'IN', at: openAt });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `blk-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'fp-blocked' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_PUNCHED_IN');
    // What the employee actually reads. The raw code must not survive into it.
    expect(body.error.message).not.toContain('ALREADY_PUNCHED_IN');
    expect(body.error.message).toContain('still checked in from');
    expect(body.error.message).toContain('Ask your manager to close that shift');
    expect(body.error.message).toContain("today's hours count from it");

    const attempts = await getTestPrisma().blockedPunchAttempt.findMany({ where: { user_id: user.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.branch_id).toBe(branch.id);
    expect(attempts[0]!.open_in_at.toISOString()).toBe(openAt.toISOString());
    expect(attempts[0]!.accuracy_m).toBe(12);
  });

  it('records nothing when the blocked employee tries from outside the geofence', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 50 });
    const user = await seedTestUser({ username: 'emp-blocked-far', branch_id: branch.id });
    await seedTestPunch({
      user_id: user.id,
      branch_id: branch.id,
      kind: 'IN',
      at: new Date(Date.now() - 14 * 3_600_000),
    });
    const { cookies, csrf } = await loginAs(user.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/me/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `blkfar-${Date.now()}-${Math.random()}`,
        'X-CSRF-Token': csrf,
        Cookie: cookies,
      },
      body: JSON.stringify({ kind: 'IN', lat: 33.91, lng: 35.5, accuracy: 10, deviceFp: 'fp-home' }),
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('OUT_OF_GEOFENCE');
    const attempts = await getTestPrisma().blockedPunchAttempt.count({ where: { user_id: user.id } });
    expect(attempts).toBe(0);
  });
});
