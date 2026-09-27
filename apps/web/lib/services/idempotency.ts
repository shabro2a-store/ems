import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { IDEMPOTENCY_TTL_HOURS } from '@/lib/auth/constants';

export interface CachedIdempotentResponse {
  status_code: number;
  response_json: unknown;
}

export interface ConsumeOptions {
  key: string;
  userId: string;
  /** The route the key is used on (its path). A key cannot replay across routes. */
  scope: string;
}

/**
 * How long a claim holds while its request works. A request that claims a key
 * and then fails without storing an answer leaves the claim behind; after this
 * it may be taken over, so a genuine retry is never locked out for long.
 */
export const IDEMPOTENCY_LEASE_MS = 60_000;

function ttlExpiresAt(now: Date): Date {
  return new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
}

function refusal(code: 'IN_PROGRESS' | 'KEY_REUSED', message: string): CachedIdempotentResponse {
  return { status_code: 409, response_json: { ok: false, error: { code, message } } };
}

const IN_PROGRESS = refusal(
  'IN_PROGRESS',
  'This is already being done - it was sent twice. Wait a moment, then refresh to see the result.',
);
const KEY_REUSED = refusal('KEY_REUSED', 'This request was already used for something else. Try again.');

/**
 * Claim the key for this request, or answer for it.
 *
 * Returns null when this request has the key and must do the work (then store
 * its answer with storeIdempotentResponse). Otherwise returns what to send:
 * the stored answer of the request that already did it, or a refusal while
 * that request is still working.
 *
 * The claim is an insert, and the key is the primary key, so of any number of
 * requests arriving together exactly one gets it. Reading first and writing
 * after - as this used to - let every one of them read "nothing yet".
 */
export async function readIdempotentResponse(
  opts: ConsumeOptions,
  now: Date = new Date(),
): Promise<CachedIdempotentResponse | null> {
  const where = { key_user_id: { key: opts.key, user_id: opts.userId } };
  const claim = {
    scope: opts.scope,
    status_code: 0,
    response_json: Prisma.DbNull,
    created_at: now,
    expires_at: ttlExpiresAt(now),
  };
  // DO NOTHING rather than catching the duplicate: a second tap is routine,
  // and a caught unique violation still lands in the log as an error.
  const inserted = await prisma.$executeRaw`
    INSERT INTO "IdempotencyKey" (key, user_id, scope, status_code, response_json, created_at, expires_at)
    VALUES (${opts.key}, ${opts.userId}, ${opts.scope}, 0, NULL, ${now}, ${claim.expires_at})
    ON CONFLICT (key, user_id) DO NOTHING`;
  if (inserted === 1) return null;

  const row = await prisma.idempotencyKey.findUnique({ where });
  if (!row) return IN_PROGRESS;
  const expired = row.expires_at <= now;
  const abandoned = row.status_code === 0 && now.getTime() - row.created_at.getTime() > IDEMPOTENCY_LEASE_MS;
  if (expired || abandoned) {
    // Take it over - but only if nobody else has since: the update names the
    // exact row it saw.
    const { count } = await prisma.idempotencyKey.updateMany({
      where: { key: opts.key, user_id: opts.userId, created_at: row.created_at },
      data: claim,
    });
    return count === 1 ? null : IN_PROGRESS;
  }
  if (row.scope && row.scope !== opts.scope) return KEY_REUSED;
  if (row.status_code === 0) return IN_PROGRESS;
  return { status_code: row.status_code, response_json: row.response_json };
}

export async function storeIdempotentResponse(
  opts: ConsumeOptions & CachedIdempotentResponse,
  now: Date = new Date(),
): Promise<void> {
  await prisma.idempotencyKey.upsert({
    where: { key_user_id: { key: opts.key, user_id: opts.userId } },
    create: {
      key: opts.key,
      user_id: opts.userId,
      scope: opts.scope,
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
