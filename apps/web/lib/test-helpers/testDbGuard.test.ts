import { describe, it, expect } from 'vitest';
import { assertTestDatabaseUrl } from './testDbGuard';

/*
 * The integration helpers TRUNCATE every table they seed. They read the root
 * .env when nothing else is set, and that file points at the dev database - or,
 * on the VPS, at production. One `pnpm -r test` there and the data is gone.
 */
describe('which database the test helpers will touch', () => {
  it('accepts a database whose name ends in _test', () => {
    expect(() => assertTestDatabaseUrl('postgresql://ems:test@localhost:5432/ems_test')).not.toThrow();
    expect(() => assertTestDatabaseUrl('postgresql://ems:pw@127.0.0.1:5434/ems_test?schema=public')).not.toThrow();
  });

  it('refuses the dev and production database', () => {
    expect(() => assertTestDatabaseUrl('postgresql://ems:ems_dev_password@localhost:5433/ems')).toThrow(/ems_test/);
    expect(() => assertTestDatabaseUrl('postgresql://ems:secret@db:5432/ems')).toThrow(/"ems"/);
  });

  it('refuses a name that only contains the word', () => {
    expect(() => assertTestDatabaseUrl('postgresql://ems:pw@localhost/ems_test_backup')).toThrow();
    expect(() => assertTestDatabaseUrl('postgresql://ems:pw@localhost/test')).toThrow();
  });

  it('refuses when there is no database url at all', () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertTestDatabaseUrl('not a url')).toThrow(/DATABASE_URL/);
  });

  it('never repeats the password in its message', () => {
    try {
      assertTestDatabaseUrl('postgresql://ems:hunter2@localhost:5433/ems');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});
