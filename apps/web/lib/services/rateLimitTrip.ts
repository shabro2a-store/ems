import { prisma } from '@/lib/db/prisma';
import { PUNCH_RATE_LIMIT_PER_MIN } from '@/lib/auth/constants';
import { consumeRateLimit } from './rateLimit';

export interface ConsumeTripOpts {
  userId: string;
}

const WINDOW_MS = 60_000;

export async function consumeTripRateLimit(
  opts: ConsumeTripOpts,
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  // One statement (consumeRateLimit): reading the bucket and then creating it
  // let two taps at once both insert, and the loser came back as a 500.
  return consumeRateLimit(prisma, `user:${opts.userId}:trip`, PUNCH_RATE_LIMIT_PER_MIN, WINDOW_MS);
}
