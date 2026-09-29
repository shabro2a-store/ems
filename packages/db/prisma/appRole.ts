import { PrismaClient } from '@prisma/client';

/** The role web and worker log in as. Migrations and backups keep the owner (`ems`). */
export const APP_ROLE = 'ems_app';

/**
 * Creates (or updates) the app's database role and gives it exactly what the
 * app does at run time: read and write rows. It cannot create, alter or drop
 * anything, cannot switch off the trigger that keeps AuditLog append-only (only
 * an owner can), and may only add to AuditLog and read it. Runs after every
 * `prisma migrate deploy` (the compose `migrate` service), so a table added by
 * a migration is granted in the same deploy, and changing APP_DB_PASSWORD in
 * .env followed by `docker compose up -d` is the whole of a rotation.
 */
export async function applyAppRole(prisma: PrismaClient, password: string): Promise<void> {
  if (password.length < 16) {
    throw new Error('APP_DB_PASSWORD must be at least 16 characters (openssl rand -hex 24)');
  }
  // It also goes inside web's and worker's DATABASE_URL, where an @, / or : would
  // silently point the connection somewhere else.
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error('APP_DB_PASSWORD may only contain letters, digits, - and _ (openssl rand -hex 24)');
  }
  // format(%L) quotes the password inside Postgres; ALTER ROLE takes no bind parameters.
  const [{ sql }] = await prisma.$queryRaw<Array<{ sql: string }>>`
    SELECT format(
      'ALTER ROLE ems_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
      ${password}::text
    ) AS sql`;

  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ems_app') THEN CREATE ROLE ems_app; END IF; END $$`,
    ),
    prisma.$executeRawUnsafe(sql!),
    prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO ems_app'),
    prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ems_app'),
    prisma.$executeRawUnsafe('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems_app'),
    prisma.$executeRawUnsafe('REVOKE ALL ON "_prisma_migrations" FROM ems_app'),
    prisma.$executeRawUnsafe('REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM ems_app'),
  ]);
}
