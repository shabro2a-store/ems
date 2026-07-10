import { prisma } from '@/lib/db/prisma';
import { IDEMPOTENCY_TTL_HOURS } from '@/lib/auth/constants';

export interface CachedIdempotentResponse {
  status_code: number;
  response_json: unknown;
}

export interface ConsumeOptions {
  key: string;
  userId: string;
}

function ttlExpiresAt(now: Date): Date {
  return new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
}

export async function readIdempotentResponse(
  opts: ConsumeOptions,
): Promise<CachedIdempotentResponse | null> {
  const row = await prisma.idempotencyKey.findUnique({
    where: { key_user_id: { key: opts.key, user_id: opts.userId } },
  });
  if (!row) return null;
  if (row.expires_at <= new Date()) return null;
  return { status_code: row.status_code, response_json: row.response_json };
}

export async function storeIdempotentResponse(
  opts: ConsumeOptions & CachedIdempotentResponse,
): Promise<void> {
  const now = new Date();
  await prisma.idempotencyKey.upsert({
    where: { key_user_id: { key: opts.key, user_id: opts.userId } },
    create: {
      key: opts.key,
      user_id: opts.userId,
      response_json: opts.response_json as object,
      status_code: opts.status_code,
      created_at: now,
      expires_at: ttlExpiresAt(now),
    },
    update: {
      response_json: opts.response_json as object,
      status_code: opts.status_code,
    },
  });
}
