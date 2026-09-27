import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb } from '../test-helpers/db';

/*
 * Security #7: AuditLog was meant to be append-only - a migration REVOKEs
 * UPDATE and DELETE from `ems_app` - but the app connects as the database
 * owner, a role no REVOKE touches, so the record could be rewritten by the
 * very code it records. A trigger refuses it for every role.
 */
describe('the audit log', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  async function entry() {
    return getTestPrisma().auditLog.create({
      data: { actor_id: 'a', action: 'user.create', entity: 'User', entity_id: 'u' },
    });
  }

  it('cannot be edited', async () => {
    const row = await entry();
    await expect(getTestPrisma().auditLog.update({ where: { id: row.id }, data: { action: 'nothing.happened' } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('cannot have entries deleted', async () => {
    await entry();
    await expect(getTestPrisma().auditLog.deleteMany()).rejects.toThrow(/append-only/);
    expect(await getTestPrisma().auditLog.count()).toBe(1);
  });

  it('still takes new entries', async () => {
    await entry();
    await entry();
    expect(await getTestPrisma().auditLog.count()).toBe(2);
  });
});
