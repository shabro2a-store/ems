import { prisma } from '@/lib/db/prisma';
import { ADVANCE_RATE_LIMIT_PER_MIN } from '@/lib/auth/constants';

export interface ConsumeAdvanceOpts {
  userId: string;
}

const WINDOW_MS = 60_000;

export async function consumeAdvanceRateLimit(
  opts: ConsumeAdvanceOpts,
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const identifier = `user:${opts.userId}:advance`;
  const now = new Date();
  const windowAgo = new Date(now.getTime() - WINDOW_MS);

  const existing = await prisma.rateLimitBucket.findUnique({ where: { identifier } });

  if (!existing) {
    await prisma.rateLimitBucket.create({
      data: { identifier, tokens: ADVANCE_RATE_LIMIT_PER_MIN - 1, refilled_at: now },
    });
    return { allowed: true };
  }

  if (existing.refilled_at < windowAgo) {
    await prisma.rateLimitBucket.update({
      where: { identifier },
      data: { tokens: ADVANCE_RATE_LIMIT_PER_MIN - 1, refilled_at: now },
    });
    return { allowed: true };
  }

  if (existing.tokens <= 0) {
    const retryAfterSec = Math.max(1, Math.ceil((windowAgo.getTime() + WINDOW_MS - now.getTime()) / 1000));
    return { allowed: false, retryAfterSec };
  }

  await prisma.rateLimitBucket.update({
    where: { identifier },
    data: { tokens: { decrement: 1 } },
  });
  return { allowed: true };
}