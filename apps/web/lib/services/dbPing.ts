import { prisma } from '@/lib/db/prisma';

/** Under the container healthcheck's own 5 s timeout, so a hung database reads as unhealthy, not as a timed-out check. */
export const HEALTH_DB_TIMEOUT_MS = 3_000;

/** True when Postgres answers a real query in time. What it said on failure goes to the log only. */
export async function databaseAnswers(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${HEALTH_DB_TIMEOUT_MS} ms`)), HEALTH_DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch (e) {
    console.error('[health] database unreachable', e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
