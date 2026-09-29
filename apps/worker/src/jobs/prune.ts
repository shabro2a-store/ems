import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';

/** A driver call is only read in the half hour after it rings; the rest is a tail for questions. */
export const CALL_KEEP_DAYS = 90;
/** A resolved flag stays in the history lists for half a year. */
export const RESOLVED_FLAG_KEEP_DAYS = 180;

const DAY_MS = 86_400_000;

export interface PruneOpts {
  db?: PrismaClient;
  now?: Date;
}

export interface PruneResult {
  idempotencyKeys: number;
  rateLimitBuckets: number;
  driverCalls: number;
  flags: number;
}

/**
 * Deletes rows that only matter for a while, which nothing else ever removed:
 * replay keys a day past their expiry, rate-limit buckets untouched for a day
 * (the longest window is 15 minutes, so the bucket is full again anyway),
 * driver calls older than CALL_KEEP_DAYS and flags resolved more than
 * RESOLVED_FLAG_KEEP_DAYS ago.
 *
 * Never BlockedPunchAttempt - past pay is recomputed from it - and never
 * AuditLog, which a trigger keeps append-only.
 */
export async function runPrune(opts: PruneOpts = {}): Promise<PruneResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const idempotencyKeys = (await db.idempotencyKey.deleteMany({ where: { expires_at: { lt: dayAgo } } })).count;
  const rateLimitBuckets = (await db.rateLimitBucket.deleteMany({ where: { refilled_at: { lt: dayAgo } } })).count;
  const driverCalls = (
    await db.driverCall.deleteMany({ where: { created_at: { lt: new Date(now.getTime() - CALL_KEEP_DAYS * DAY_MS) } } })
  ).count;
  const flags = (
    await db.flag.deleteMany({
      where: { resolved_at: { lt: new Date(now.getTime() - RESOLVED_FLAG_KEEP_DAYS * DAY_MS) } },
    })
  ).count;

  const result = { idempotencyKeys, rateLimitBuckets, driverCalls, flags };
  if (idempotencyKeys + rateLimitBuckets + driverCalls + flags > 0) console.log('[prune] deleted', result);
  return result;
}
