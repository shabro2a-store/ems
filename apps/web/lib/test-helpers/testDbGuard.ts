/**
 * Refuse any database the test helpers would wipe unless its name says it is
 * for tests.
 *
 * The helpers TRUNCATE every table they seed, and when nothing is exported they
 * read the root .env - which points at the dev database, or on the VPS at
 * production. The name is the one thing every setup already gets right: CI
 * uses `ems_test`, and a database meant to be thrown away can always be called
 * that. The password is never echoed back.
 */
export function assertTestDatabaseUrl(url: string | undefined): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url ?? '').pathname.replace(/^\//, ''));
  } catch {
    throw new Error(
      'Integration tests need DATABASE_URL pointing at a throwaway database whose name ends in _test ' +
        '(e.g. .../ems_test). See README "Checks".',
    );
  }
  if (!/_test$/.test(name)) {
    throw new Error(
      `Refusing to run: the test helpers erase every table, and DATABASE_URL names the database "${name}". ` +
        'Point DATABASE_URL (and the web server under test) at a database whose name ends in _test, ' +
        'e.g. .../ems_test. See README "Checks".',
    );
  }
}
