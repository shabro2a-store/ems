import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestUser, seedTestBranch, seedTestFlag } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('admin-flags integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('GET /api/admin/now returns all flag kinds', async () => {
    const admin = await seedTestUser({ username: 'fl-admin1', role: Role.ADMIN });
    const branch = await seedTestBranch();
    const employee = await seedTestUser({ username: 'fl-emp1', branch_id: branch.id });

    await seedTestFlag({ kind: 'WATCHED', user_id: employee.id, branch_id: branch.id, context_json: {} });
    await seedTestFlag({ kind: 'MISSED_CHECKOUT', user_id: employee.id, branch_id: branch.id, context_json: {} });
    await seedTestFlag({ kind: 'TRIP_OVER_THRESHOLD', user_id: employee.id, branch_id: branch.id, context_json: {} });

    const session = await loginAs(admin.username, 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/now`, {
      headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
      credentials: 'include',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { flags: Array<{ kind: string }> } };
    expect(body.ok).toBe(true);
    const kinds = body.data?.flags.map((f) => f.kind) ?? [];
    expect(kinds).toContain('WATCHED');
    expect(kinds).toContain('MISSED_CHECKOUT');
    expect(kinds).toContain('TRIP_OVER_THRESHOLD');
  });
});