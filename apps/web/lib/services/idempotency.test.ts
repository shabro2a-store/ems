import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<
    string,
    { key: string; user_id: string; status_code: number; response_json: unknown; expires_at: Date }
  >();
  const k = (userId: string, key: string) => JSON.stringify([userId, key]);
  return {
    rows,
    k,
    prisma: {
      idempotencyKey: {
        findUnique: async ({ where }: { where: { key_user_id: { key: string; user_id: string } } }) => {
          const id = k(where.key_user_id.user_id, where.key_user_id.key);
          const row = rows.get(id);
          return row
            ? {
                key: row.key,
                user_id: row.user_id,
                status_code: row.status_code,
                response_json: row.response_json,
                created_at: new Date(),
                expires_at: row.expires_at,
              }
            : null;
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { key_user_id: { key: string; user_id: string } };
          create: { key: string; user_id: string; response_json: unknown; status_code: number; created_at: Date; expires_at: Date };
          update: { response_json: unknown; status_code: number };
        }) => {
          const id = k(where.key_user_id.user_id, where.key_user_id.key);
          const existing = rows.get(id);
          const data = existing
            ? {
                key: where.key_user_id.key,
                user_id: where.key_user_id.user_id,
                status_code: update.status_code,
                response_json: update.response_json,
                expires_at: existing.expires_at,
              }
            : {
                key: create.key,
                user_id: create.user_id,
                status_code: create.status_code,
                response_json: create.response_json,
                expires_at: create.expires_at,
              };
          rows.set(id, data);
          return data;
        },
      },
    },
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: mocks.prisma as unknown as Record<string, never> }));

import { readIdempotentResponse, storeIdempotentResponse } from './idempotency';

describe('idempotency', () => {
  it('returns null when no cached response exists', async () => {
    mocks.rows.clear();
    const r = await readIdempotentResponse({ userId: 'u1', key: 'k1' });
    expect(r).toBeNull();
  });

  it('returns cached response and updates it on store', async () => {
    mocks.rows.clear();
    await storeIdempotentResponse({
      userId: 'u1',
      key: 'k1',
      status_code: 200,
      response_json: { ok: true, data: { a: 1 } },
    });
    const r = await readIdempotentResponse({ userId: 'u1', key: 'k1' });
    expect(r).not.toBeNull();
    expect(r!.status_code).toBe(200);
    expect(r!.response_json).toEqual({ ok: true, data: { a: 1 } });
  });

  it('expires after 24h — read returns null', async () => {
    mocks.rows.clear();
    mocks.rows.set(mocks.k('u1', 'k1'), {
      key: 'k1',
      user_id: 'u1',
      status_code: 200,
      response_json: { a: 1 },
      expires_at: new Date(Date.now() - 60_000),
    });
    const r = await readIdempotentResponse({ userId: 'u1', key: 'k1' });
    expect(r).toBeNull();
  });

  it('different user with same key is independent', async () => {
    mocks.rows.clear();
    await storeIdempotentResponse({
      userId: 'u1',
      key: 'k1',
      status_code: 200,
      response_json: { which: 'u1' },
    });
    const r = await readIdempotentResponse({ userId: 'u2', key: 'k1' });
    expect(r).toBeNull();
  });
});
