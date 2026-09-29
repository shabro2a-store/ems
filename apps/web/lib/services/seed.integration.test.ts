import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDb, getTestPrisma, seedTestBranch, seedTestPunch, seedTestUser } from '@/lib/test-helpers/db';
import { seedDatabase } from '../../../../packages/db/prisma/seedDatabase';

// The seed used to wipe every table before filling it, so running it on the
// live server (the docs once said "after schema changes") erased the company's
// records. It now fills an empty database and refuses anything else.
describe('seed', () => {
  beforeEach(async () => {
    await cleanDb();
  });
  afterAll(async () => {
    await cleanDb();
  });

  it('fills an empty database with the owner, two branches and two employees', async () => {
    await seedDatabase(getTestPrisma());
    const users = await getTestPrisma().user.findMany({ select: { username: true }, orderBy: { username: 'asc' } });
    expect(users.map((u) => u.username)).toEqual(['emp1', 'emp2', 'owner']);
    expect(await getTestPrisma().branch.count()).toBe(2);
  });

  it('refuses a database that already has people in it, and deletes nothing', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'realperson', branch_id: branch.id });
    await seedTestPunch({ user_id: user.id, branch_id: branch.id });

    await expect(seedDatabase(getTestPrisma())).rejects.toThrow(/already has data/);

    expect(await getTestPrisma().user.count()).toBe(1);
    expect(await getTestPrisma().branch.count()).toBe(1);
    expect(await getTestPrisma().punch.count()).toBe(1);
  });

  it('refuses a second run', async () => {
    await seedDatabase(getTestPrisma());
    await expect(seedDatabase(getTestPrisma())).rejects.toThrow(/already has data/);
    expect(await getTestPrisma().user.count()).toBe(3);
  });
});
