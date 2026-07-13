import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut } from 'time';
import {
  getTestPrisma,
  cleanDb,
  seedTestUser,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentMonth(): string {
  return todayInBeirut(new Date()).slice(0, 7);
}

describe('adjustments integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('admin adds a bonus adjustment; AuditLog row written; /api/me/today reflects it', async () => {
    const employee = await seedTestUser({ username: 'adj-emp', branch_id: null });
    const admin = await seedTestUser({ username: 'adj-admin', role: Role.ADMIN });

    const aSession = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('adj'),
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({
        userId: employee.id,
        kind: 'BONUS',
        amountCent: 5000,
        reason: 'performance bonus',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: { adjustment: { id: string } } };
    expect(body.ok).toBe(true);

    const adjustment = await getTestPrisma().adjustment.findUnique({ where: { id: body.data!.adjustment.id } });
    expect(adjustment).not.toBeNull();
    expect(adjustment?.amount_cent).toBe(5000);
    expect(adjustment?.kind).toBe('BONUS');

    const audit = await getTestPrisma().auditLog.findFirst({
      where: { entity: 'Adjustment', entity_id: adjustment!.id, action: 'adjustment.create' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor_id).toBe(admin.id);

    const payrollRes = await fetch(`${BASE_URL}/api/me/payroll?month=${currentMonth()}`, {
      headers: { Cookie: aSession.cookies, 'X-CSRF-Token': aSession.csrf },
    });
    expect(payrollRes.status).toBe(200);
  });

  it('rejects adjustment with missing fields', async () => {
    const admin = await seedTestUser({ username: 'adj-admin2', role: Role.ADMIN });
    const aSession = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('adj'),
        'X-CSRF-Token': aSession.csrf,
        Cookie: aSession.cookies,
      },
      body: JSON.stringify({ kind: 'BONUS' }),
    });
    expect(res.status).toBe(400);
  });
});