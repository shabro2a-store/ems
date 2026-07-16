import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('notification-prefs integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('PATCH /api/admin/users/:id/notification-prefs updates both booleans', async () => {
    const admin = await seedTestUser({ username: 'np-admin1', role: Role.ADMIN });
    const target = await seedTestUser({ username: 'np-target1', role: Role.ADMIN });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${target.id}/notification-prefs`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({
        dailySummary: false,
        routinePings: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data?: { user: { notify_daily_summary: boolean; notify_routine_pings: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.data?.user.notify_daily_summary).toBe(false);
    expect(body.data?.user.notify_routine_pings).toBe(false);
  });

  it('rejects unknown fields', async () => {
    const admin = await seedTestUser({ username: 'np-admin2', role: Role.ADMIN });
    const target = await seedTestUser({ username: 'np-target2', role: Role.ADMIN });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${target.id}/notification-prefs`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({
        dailySummary: true,
        unknownField: 'oops',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects when neither field is provided', async () => {
    const admin = await seedTestUser({ username: 'np-admin3', role: Role.ADMIN });
    const target = await seedTestUser({ username: 'np-target3', role: Role.ADMIN });
    const session = await loginAs(admin.username, 'change-me');

    const res = await fetch(`${BASE_URL}/api/admin/users/${target.id}/notification-prefs`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookies,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});