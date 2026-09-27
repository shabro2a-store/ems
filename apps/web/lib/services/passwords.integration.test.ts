import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs, type LoginSession } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

async function post(session: LoginSession, path: string, body: unknown, idemKey?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrf,
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('passwords', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  /*
   * Security #4: creating a person answered with their password, and that
   * answer was kept - in plain text - as the replay for the Idempotency-Key,
   * where it sat in every backup. The owner typed the password; nothing needs
   * to send it back, so nothing keeps it.
   */
  it('is never kept in plain text when a person is created', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'pw-owner', role: Role.ADMIN });
    const admin = await loginAs('pw-owner', 'test-pass-1');
    const res = await post(
      admin,
      '/api/admin/users',
      { username: 'pw-new', password: 'Very-Secret-42', role: 'EMPLOYEE', branchId: branch.id, hourlyRateCent: 300 },
      'pw-create-1',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('Very-Secret-42');

    const kept = await getTestPrisma().idempotencyKey.findMany();
    expect(kept.length).toBeGreaterThan(0);
    expect(JSON.stringify(kept.map((k) => k.response_json))).not.toContain('Very-Secret-42');
  });

  /*
   * Security #5: the reset route set any account's password - the owner's own
   * included - without the current one, so a signed-in admin tab left open was
   * enough to take the admin account. The owner changes their own with the
   * Password dialog, which asks for the current password.
   */
  it("cannot be reset on the owner's own account", async () => {
    const owner = await seedTestUser({ username: 'pw-self', role: Role.ADMIN });
    const admin = await loginAs('pw-self', 'test-pass-1');
    const res = await post(admin, `/api/admin/users/${owner.id}/reset-password`, { password: 'taken-over-123' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OWN_PASSWORD');
    await expect(loginAs('pw-self', 'test-pass-1')).resolves.toBeTruthy();
  });

  /*
   * Security #14: the seed's admin password, `change-me`, is written in the
   * repo and the docs. Login answered `mustChangePassword` and nothing read it,
   * so an owner who never changed it left the admin account open to anyone.
   * Now it only ever works to choose a new one.
   */
  it('lets the admin in with the seed password only to choose a new one', async () => {
    await seedTestUser({ username: 'pw-seeded', role: Role.ADMIN, password: 'change-me' });
    const login = (body: unknown) =>
      fetch(`${BASE_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const refused = await login({ username: 'pw-seeded', password: 'change-me' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(refused.headers.get('set-cookie') ?? '').not.toContain('ems_access');

    const sameAgain = await login({ username: 'pw-seeded', password: 'change-me', newPassword: 'change-me' });
    expect(sameAgain.status).toBe(400);

    const changed = await login({ username: 'pw-seeded', password: 'change-me', newPassword: 'owner-chose-this' });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('set-cookie') ?? '').toContain('ems_access');
    await expect(loginAs('pw-seeded', 'owner-chose-this')).resolves.toBeTruthy();
    await expect(loginAs('pw-seeded', 'change-me')).rejects.toThrow();
  });

  it('leaves a staff member whose password is change-me to sign in as usual', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'pw-staff', branch_id: branch.id, password: 'change-me' });
    await expect(loginAs('pw-staff', 'change-me')).resolves.toBeTruthy();
  });

  it("can still be reset on somebody else's account", async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'pw-emp', branch_id: branch.id });
    await seedTestUser({ username: 'pw-admin', role: Role.ADMIN });
    const admin = await loginAs('pw-admin', 'test-pass-1');
    const res = await post(admin, `/api/admin/users/${emp.id}/reset-password`, { password: 'a-new-password' });
    expect(res.status).toBe(200);
    await expect(loginAs('pw-emp', 'a-new-password')).resolves.toBeTruthy();
  });
});
