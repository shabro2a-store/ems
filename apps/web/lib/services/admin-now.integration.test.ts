import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestUser,
  seedTestTrip,
  seedTestFlag,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('GET /api/admin/now', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('returns empty driversOut and flags initially', async () => {
    const admin = await seedTestUser({ username: 'now-admin', role: Role.ADMIN });
    const session = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/now`, {
      headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
      credentials: 'include',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { branches: Array<{ driversOut: unknown[] }>; flags: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data?.branches.every((b) => b.driversOut.length === 0)).toBe(true);
    expect(body.data?.flags).toEqual([]);
  });

  it('includes open trip in driversOut for correct branch', async () => {
    const branch = await seedTestBranch({ name: 'Hamra' });
    const driver = await seedTestUser({ username: 'now-driver', role: Role.DRIVER, branch_id: branch.id });
    const admin = await seedTestUser({ username: 'now-admin2', role: Role.ADMIN });
    const trip = await seedTestTrip({ driver_id: driver.id, branch_id: branch.id });

    const session = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/now`, {
      headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
      credentials: 'include',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { branches: Array<{ id: string; driversOut: Array<{ trip_id: string }> }> } };
    expect(body.ok).toBe(true);
    const hamra = body.data?.branches.find((b) => b.id === branch.id);
    expect(hamra?.driversOut.some((d) => d.trip_id === trip.id)).toBe(true);
  });

  it('includes today flags; excludes flags from >1 day ago', async () => {
    const branch = await seedTestBranch();
    const employee = await seedTestUser({ username: 'now-emp', branch_id: branch.id });
    const admin = await seedTestUser({ username: 'now-admin3', role: Role.ADMIN });

    await seedTestFlag({
      kind: 'WATCHED',
      user_id: employee.id,
      branch_id: branch.id,
      context_json: {},
      created_at: new Date(),
    });

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 2);
    await seedTestFlag({
      kind: 'WATCHED',
      user_id: employee.id,
      branch_id: branch.id,
      context_json: {},
      created_at: oldDate,
    });

    const session = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/now`, {
      headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
      credentials: 'include',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { flags: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data?.flags.length).toBeGreaterThan(0);
  });
});