import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestUser, seedTestBranch } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('admin-branches integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('PATCH updates branch fields', async () => {
    const admin = await seedTestUser({ username: 'b-admin1', role: Role.ADMIN });
    const branch = await seedTestBranch({ name: 'Hamra', gps_radius_m: 50 });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/branches/${branch.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('br1'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({
        gpsRadiusM: 75,
        absentGraceMin: 20,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { branch: { gps_radius_m: number; absent_grace_min: number } } };
    expect(body.ok).toBe(true);
    expect(body.data?.branch.gps_radius_m).toBe(75);
    expect(body.data?.branch.absent_grace_min).toBe(20);
  });

  it('rejects out-of-range radius', async () => {
    const admin = await seedTestUser({ username: 'b-admin2', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/branches/${branch.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('br2'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ gpsRadiusM: 99999 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range accuracy', async () => {
    const admin = await seedTestUser({ username: 'b-admin3', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/branches/${branch.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('br3'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ gpsAccuracyMaxM: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range trip threshold', async () => {
    const admin = await seedTestUser({ username: 'b-admin4', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/branches/${branch.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey('br4'),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({ tripThresholdMin: 500 }),
    });
    expect(res.status).toBe(400);
  });
});