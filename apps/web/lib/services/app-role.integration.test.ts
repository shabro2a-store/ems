import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { cleanDb, getTestPrisma, seedTestBranch, seedTestUser } from '@/lib/test-helpers/db';
import { applyAppRole, APP_ROLE } from '../../../../packages/db/prisma/appRole';

/*
 * web and worker used to log in as the database owner, so a bug or an injected
 * query in the app could drop tables, switch off the trigger that keeps the
 * audit log append-only, or rewrite the log directly. They now log in as
 * ems_app, which can read and write rows and nothing else; migrations keep the
 * owner.
 */
const PASSWORD = 'test-app-role-password-0123456789';

function appClient(password = PASSWORD): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = APP_ROLE;
  url.password = password;
  return new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
}

describe('the app database role', () => {
  let app: PrismaClient;

  beforeAll(async () => {
    await cleanDb();
    await applyAppRole(getTestPrisma(), PASSWORD);
    app = appClient();
  });

  afterAll(async () => {
    await app.$disconnect();
    await cleanDb();
  });

  it('reads and writes ordinary rows', async () => {
    const branch = await seedTestBranch();
    const user = await seedTestUser({ username: 'role-rw', branch_id: branch.id });
    await app.punch.create({
      data: { user_id: user.id, branch_id: branch.id, kind: 'IN', at: new Date(), lat: 0, lng: 0, accuracy_m: 5, device_fp: 'fp', ip: '127.0.0.1' },
    });
    await app.user.update({ where: { id: user.id }, data: { name: 'Renamed' } });
    expect(await app.punch.count({ where: { user_id: user.id } })).toBe(1);
    await app.punch.deleteMany({ where: { user_id: user.id } });
    expect(await app.punch.count({ where: { user_id: user.id } })).toBe(0);
  });

  it('adds to the audit log and reads it, but cannot change or empty it', async () => {
    await app.auditLog.create({ data: { actor_id: 'system', action: 'test', entity: 'Test', entity_id: 'x' } });
    expect(await app.auditLog.count()).toBeGreaterThan(0);
    await expect(app.auditLog.updateMany({ data: { action: 'rewritten' } })).rejects.toThrow(/permission denied/);
    await expect(app.auditLog.deleteMany()).rejects.toThrow(/permission denied/);
    await expect(app.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/permission denied/);
  });

  it('cannot change the schema or switch off the audit trigger', async () => {
    await expect(app.$executeRawUnsafe('CREATE TABLE intruder (id int)')).rejects.toThrow(/permission denied/);
    await expect(app.$executeRawUnsafe('DROP TABLE "Punch"')).rejects.toThrow(/must be owner/);
    await expect(app.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER ALL')).rejects.toThrow(/must be owner/);
    await expect(app.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"')).rejects.toThrow(/permission denied/);
  });

  it('can be applied again, and takes a new password', async () => {
    await applyAppRole(getTestPrisma(), `${PASSWORD}-rotated`);
    const rotated = appClient(`${PASSWORD}-rotated`);
    try {
      expect(await rotated.user.count()).toBeGreaterThanOrEqual(0);
    } finally {
      await rotated.$disconnect();
    }
    await expect(appClient().$queryRawUnsafe('SELECT 1')).rejects.toThrow(/authentication failed/i);
    await applyAppRole(getTestPrisma(), PASSWORD);
  });

  it('refuses a short password, or one a connection URL would mangle', async () => {
    await expect(applyAppRole(getTestPrisma(), 'short')).rejects.toThrow(/at least 16/);
    await expect(applyAppRole(getTestPrisma(), 'long-enough-but@has/url:chars')).rejects.toThrow(/letters, digits/);
  });
});
