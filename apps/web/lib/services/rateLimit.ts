import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { PUNCH_RATE_LIMIT_PER_MIN } from '@/lib/auth/constants';

export interface ConsumePunchOpts {
  userId: string;
}

const PUNCH_WINDOW_MS = 60_000;

export async function consumePunchRateLimit(
  opts: ConsumePunchOpts,
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  // One statement (consumeRateLimit): reading the bucket and then creating it
  // let two taps at once both insert, and the loser came back as a 500.
  return consumeRateLimit(prisma, `user:${opts.userId}:punch`, PUNCH_RATE_LIMIT_PER_MIN, PUNCH_WINDOW_MS);
}

/**
 * Take one attempt from `identifier`'s bucket of `limit` per `windowMs`, in a
 * single statement.
 *
 * Every limiter goes through here. They used to read the bucket and then
 * write it, so attempts arriving together all read "tokens left" before any of
 * them wrote - twenty at once went through a limit of five, and two at once on
 * an empty bucket both inserted it, the loser failing with a 500. An upsert is one statement, and Postgres
 * serialises it on the row: exactly `limit` get through, whatever the timing.
 * The count may go below zero while the window lasts; the first attempt after
 * it starts a fresh one.
 */
export async function consumeRateLimit(
  db: PrismaClient,
  identifier: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const windowStart = new Date(now.getTime() - windowMs);
  const rows = await db.$queryRaw<Array<{ tokens: number; refilled_at: Date }>>`
    INSERT INTO "RateLimitBucket" (identifier, tokens, refilled_at)
    VALUES (${identifier}, ${limit - 1}, ${now})
    ON CONFLICT (identifier) DO UPDATE SET
      tokens = CASE WHEN "RateLimitBucket".refilled_at <= ${windowStart}
                    THEN ${limit - 1} ELSE "RateLimitBucket".tokens - 1 END,
      refilled_at = CASE WHEN "RateLimitBucket".refilled_at <= ${windowStart}
                         THEN ${now} ELSE "RateLimitBucket".refilled_at END
    RETURNING tokens, refilled_at`;
  const row = rows[0]!;
  if (row.tokens >= 0) return { allowed: true };
  const retryAfterSec = Math.max(1, Math.ceil((row.refilled_at.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: false, retryAfterSec };
}
