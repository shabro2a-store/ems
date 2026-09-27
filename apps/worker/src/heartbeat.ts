import { readFileSync, writeFileSync } from 'fs';
import type { PrismaClient } from '@prisma/client';

/**
 * Where the worker records that it is alive. The container's HEALTHCHECK
 * (Dockerfile.worker) reads this same path; heartbeat.test.ts pins the two.
 */
export const HEARTBEAT_FILE = '/tmp/ems-worker-heartbeat';

/** Beats every 30 s; a heartbeat older than this means the worker is stuck or cut off. */
export const HEARTBEAT_MAX_AGE_MS = 2 * 60_000;

/**
 * One real query, then the time. A worker that cannot reach its database -
 * the wrong POSTGRES_PASSWORD after a redeploy, say - does not write, so it
 * goes unhealthy instead of looking fine while every job fails.
 */
export async function beat(
  db: Pick<PrismaClient, '$queryRaw'>,
  file: string = HEARTBEAT_FILE,
  now: Date = new Date(),
): Promise<void> {
  await db.$queryRaw`SELECT 1`;
  writeFileSync(file, now.toISOString());
}

export function heartbeatIsFresh(file: string = HEARTBEAT_FILE, now: Date = new Date()): boolean {
  try {
    const at = Date.parse(readFileSync(file, 'utf8'));
    return Number.isFinite(at) && now.getTime() - at <= HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}
