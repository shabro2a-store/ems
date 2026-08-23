import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestPunch,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('punch.correct integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('creates an AuditLog row and persists the correction to the Punch row', async () => {
    const branch = await seedTestBranch();
    const employee = await seedTestUser({ username: 'corr-emp', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'corr-admin', role: Role.ADMIN });

    const originalPunch = await seedTestPunch({
      user_id: employee.id,
      branch_id: branch.id,
      kind: 'IN',
      at: new Date('2026-07-01T08:00:00Z'),
      lat: 33.8962,
      lng: 35.4827,
    });

    const aSession = await loginAs(admin.username, 'change-me');
    const newAt = '2026-07-01T09:30:00.000Z';
    const res = await fetch(`${BASE_URL}/api/admin/punches/correct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('corr'),
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({
        punchId: originalPunch.id,
        newAt,
        reason: 'employee arrived late',
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; data?: { punch: { at: string } } };
    expect(body.ok).toBe(true);
    expect(body.data?.punch.at).toBe(newAt);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'Punch', entity_id: originalPunch.id, action: 'punch.correct' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor_id).toBe(admin.id);

    // The correction is now persisted to the Punch row (previously this was a
    // no-op that only wrote an audit log).
    const dbPunch = await getTestPrisma().punch.findUnique({ where: { id: originalPunch.id } });
    expect(dbPunch?.at.toISOString()).toBe(newAt);
    expect(dbPunch?.corrected).toBe(true);
    expect(dbPunch?.corrected_by).toBe(admin.id);
    expect(dbPunch?.correction_reason).toBe('employee arrived late');
    // GPS evidence is preserved (only time/branch can be corrected).
    expect(dbPunch?.lat).toBe(33.8962);
    expect(dbPunch?.lng).toBe(35.4827);
  });

  it('corrects a system-generated auto-close exactly like any other punch', async () => {
    // autoCloseAbandoned writes the shift the employee was owed, not the hours
    // they actually worked. Correcting it is the normal path back to the truth,
    // so nothing about system_generated may make the row special here.
    const branch = await seedTestBranch();
    const employee = await seedTestUser({ username: 'corr-auto-emp', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'corr-auto-admin', role: Role.ADMIN });
    const inAt = new Date('2026-07-12T06:00:00.000Z');
    await seedTestPunch({ user_id: employee.id, branch_id: branch.id, kind: 'IN', at: inAt });
    const autoOut = await getTestPrisma().punch.create({
      data: {
        user_id: employee.id,
        branch_id: branch.id,
        kind: 'OUT',
        at: new Date('2026-07-12T14:00:00.000Z'),
        lat: branch.lat,
        lng: branch.lng,
        accuracy_m: 0,
        device_fp: 'system',
        ip: 'system',
        system_generated: true,
      },
    });

    const aSession = await loginAs(admin.username, 'change-me');
    const newAt = '2026-07-12T16:30:00.000Z';
    const res = await fetch(`${BASE_URL}/api/admin/punches/correct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('corr-auto'),
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({ punchId: autoOut.id, newAt, reason: 'he stayed until 19:30' }),
    });
    expect(res.status).toBe(200);

    const dbPunch = await getTestPrisma().punch.findUnique({ where: { id: autoOut.id } });
    expect(dbPunch?.at.toISOString()).toBe(newAt);
    expect(dbPunch?.corrected).toBe(true);
    expect(dbPunch?.corrected_by).toBe(admin.id);
    // Still system-generated: a human fixed the time, but no human made the punch.
    expect(dbPunch?.system_generated).toBe(true);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'Punch', entity_id: autoOut.id, action: 'punch.correct' },
    });
    expect(audit?.actor_id).toBe(admin.id);
  });

  it('returns 404 for unknown punch', async () => {
    const admin = await seedTestUser({ username: 'corr-admin2', role: Role.ADMIN });
    const aSession = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/punches/correct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('corr'),
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({ punchId: 'nonexistent', reason: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});