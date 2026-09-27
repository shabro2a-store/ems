import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestDriver } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #35: a driver allowed to roam, clocked in at another branch, was listed on
 * their HOME board as available - and on the board where they actually were.
 * Ringing them from home only ever got "clocked in at another branch".
 */
describe('a roaming driver clocked in elsewhere', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('is on the board where they are, and only there', async () => {
    const db = getTestPrisma();
    const home = await seedTestBranch({ name: 'Home' });
    const away = await seedTestBranch({ name: 'Away' });
    const driver = await seedTestDriver({ username: 'roam-drv', branch_id: home.id });
    await db.user.update({ where: { id: driver.id }, data: { can_roam_branches: true } });
    await db.punch.create({
      data: { user_id: driver.id, branch_id: away.id, kind: 'IN', at: new Date(Date.now() - 60 * 60_000), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
    });
    await seedTestUser({ username: 'roam-caller-home', role: Role.CALLER, branch_id: home.id });
    await seedTestUser({ username: 'roam-caller-away', role: Role.CALLER, branch_id: away.id });

    const board = async (username: string) => {
      const s = await loginAs(username, 'test-pass-1');
      const res = await fetch(`${BASE_URL}/api/caller/drivers`, { headers: { Cookie: s.cookies } });
      return ((await res.json()) as { data: { drivers: Array<{ id: string; available: boolean; roaming: boolean }> } }).data.drivers;
    };

    expect((await board('roam-caller-home')).find((d) => d.id === driver.id)).toBeUndefined();
    const there = (await board('roam-caller-away')).find((d) => d.id === driver.id);
    expect(there).toMatchObject({ available: true, roaming: true });
  });
});
