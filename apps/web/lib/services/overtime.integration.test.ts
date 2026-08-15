import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('POST /api/admin/overtime/decision', () => {
  beforeAll(async () => {
    await cleanDb();
    await seedTestBranch();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('rejects a non-admin', async () => {
    const emp = await seedTestUser({ username: 'ot_emp', role: 'EMPLOYEE' });
    const session = await loginAs('ot_emp', 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookies,
        'X-CSRF-Token': session.csrf,
        'Idempotency-Key': idemKey('ot'),
      },
      body: JSON.stringify({ userId: emp.id, date: '2026-08-17', decision: 'REVOKED' }),
    });
    expect(res.status).toBe(403);
  });

  it('records a decision and is idempotent', async () => {
    const emp = await seedTestUser({ username: 'ot_emp2', role: 'EMPLOYEE' });
    const adminUser = await seedTestUser({ username: 'ot_admin', role: 'ADMIN' });
    const admin = await loginAs('ot_admin', 'change-me');
    const body = JSON.stringify({ userId: emp.id, date: '2026-08-17', decision: 'REVOKED' });
    const headers = {
      'Content-Type': 'application/json',
      Cookie: admin.cookies,
      'X-CSRF-Token': admin.csrf,
      'Idempotency-Key': idemKey('ot'),
    };

    const first = await fetch(`${BASE_URL}/api/admin/overtime/decision`, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);

    const second = await fetch(`${BASE_URL}/api/admin/overtime/decision`, { method: 'POST', headers, body });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);

    // The row must be keyed by a UTC-midnight Date built from the YYYY-MM-DD
    // string, exactly like scheduleOverride/penaltyWaiver, or overtimeForUser's
    // date.toISOString().slice(0, 10) lookup silently never matches it.
    const row = await getTestPrisma().overtimeDecision.findUnique({
      where: { user_id_date: { user_id: emp.id, date: new Date('2026-08-17T00:00:00.000Z') } },
    });
    expect(row).not.toBeNull();
    expect(row?.date.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(row?.decision).toBe('REVOKED');
    expect(row?.decided_by).toBe(adminUser.id);

    // Replaying the same Idempotency-Key must not write a second decision or a
    // second audit entry.
    const allForDay = await getTestPrisma().overtimeDecision.findMany({
      where: { user_id: emp.id, date: new Date('2026-08-17T00:00:00.000Z') },
    });
    expect(allForDay.length).toBe(1);

    const audits = await getTestPrisma().auditLog.findMany({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:2026-08-17`, action: 'overtime.revoked' },
    });
    expect(audits.length).toBe(1);
    expect(audits[0]?.actor_id).toBe(adminUser.id);
  });

  it('changing the decision updates the same row instead of adding a second one', async () => {
    const emp = await seedTestUser({ username: 'ot_emp3', role: 'EMPLOYEE' });
    const adminUser = await seedTestUser({ username: 'ot_admin2', role: 'ADMIN' });
    const admin = await loginAs('ot_admin2', 'change-me');
    const baseHeaders = {
      'Content-Type': 'application/json',
      Cookie: admin.cookies,
      'X-CSRF-Token': admin.csrf,
    };

    const acceptRes = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Idempotency-Key': idemKey('ot') },
      body: JSON.stringify({ userId: emp.id, date: '2026-08-18', decision: 'ACCEPTED' }),
    });
    expect(acceptRes.status).toBe(200);
    expect((await acceptRes.json()).data).toEqual({ decision: 'ACCEPTED' });

    const revokeRes = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Idempotency-Key': idemKey('ot') },
      body: JSON.stringify({ userId: emp.id, date: '2026-08-18', decision: 'REVOKED', reason: 'changed my mind' }),
    });
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).data).toEqual({ decision: 'REVOKED' });

    const rows = await getTestPrisma().overtimeDecision.findMany({
      where: { user_id: emp.id, date: new Date('2026-08-18T00:00:00.000Z') },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.decision).toBe('REVOKED');
    expect(rows[0]?.reason).toBe('changed my mind');

    const acceptedAudit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:2026-08-18`, action: 'overtime.accepted' },
    });
    const revokedAudit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'OvertimeDecision', entity_id: `${emp.id}:2026-08-18`, action: 'overtime.revoked' },
    });
    expect(acceptedAudit).not.toBeNull();
    expect(revokedAudit).not.toBeNull();
  });

  it('rejects a date that is shaped right but names no real calendar day', async () => {
    const emp = await seedTestUser({ username: 'ot_emp4', role: 'EMPLOYEE' });
    await seedTestUser({ username: 'ot_admin3', role: 'ADMIN' });
    const admin = await loginAs('ot_admin3', 'change-me');
    const baseHeaders = {
      'Content-Type': 'application/json',
      Cookie: admin.cookies,
      'X-CSRF-Token': admin.csrf,
    };

    // Day-overflow: passes the shape regex, but new Date(...) silently rolls
    // 2026-02-30 over to 2026-03-02.
    const dayOverflow = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Idempotency-Key': idemKey('ot') },
      body: JSON.stringify({ userId: emp.id, date: '2026-02-30', decision: 'REVOKED' }),
    });
    expect(dayOverflow.status).toBe(400);
    const dayOverflowBody = (await dayOverflow.json()) as { ok: boolean; error?: { code: string } };
    expect(dayOverflowBody.ok).toBe(false);
    expect(dayOverflowBody.error?.code).toBe('INVALID_INPUT');

    // Month-overflow: passes the shape regex, but new Date(...) produces an
    // Invalid Date that would otherwise throw unguarded inside Prisma.
    const monthOverflow = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Idempotency-Key': idemKey('ot') },
      body: JSON.stringify({ userId: emp.id, date: '2026-13-01', decision: 'REVOKED' }),
    });
    expect(monthOverflow.status).toBe(400);
    const monthOverflowBody = (await monthOverflow.json()) as { ok: boolean; error?: { code: string } };
    expect(monthOverflowBody.ok).toBe(false);
    expect(monthOverflowBody.error?.code).toBe('INVALID_INPUT');

    // Neither request may reach Prisma. Check for any row for this user at
    // all, not just one keyed on the literal bad string - that also rules
    // out the Feb-30 case silently writing under the rolled-over 2026-03-02.
    const rows = await getTestPrisma().overtimeDecision.findMany({ where: { user_id: emp.id } });
    expect(rows.length).toBe(0);
  });
});
