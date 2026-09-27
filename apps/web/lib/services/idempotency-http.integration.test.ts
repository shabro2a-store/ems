import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { todayInBeirut } from 'time';
import { getTestPrisma, cleanDb, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #23 through the real route: the same bonus sent twice at once - a double tap,
 * or a retry racing the original - is written once.
 */
describe('the same request twice at once', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('writes one bonus, not two', async () => {
    const emp = await seedTestUser({ username: 'idem-emp' });
    await seedTestUser({ username: 'idem-admin', role: Role.ADMIN });
    const admin = await loginAs('idem-admin', 'test-pass-1');
    const send = () =>
      fetch(`${BASE_URL}/api/admin/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: admin.cookies,
          'X-CSRF-Token': admin.csrf,
          'Idempotency-Key': 'same-tap',
        },
        body: JSON.stringify({ userId: emp.id, kind: 'BONUS', amountCent: 5000, reason: 'double tap', month: todayInBeirut().slice(0, 7) }),
      });
    const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await getTestPrisma().adjustment.count({ where: { user_id: emp.id } })).toBe(1);
  });
});
