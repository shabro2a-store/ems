import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, { identifier: string; tokens: number; refilled_at: Date }>();
  return {
    rows,
    prisma: {
      rateLimitBucket: {
        findUnique: async ({ where }: { where: { identifier: string } }) => {
          const row = rows.get(where.identifier);
          return row
            ? { identifier: row.identifier, tokens: row.tokens, refilled_at: row.refilled_at }
            : null;
        },
        create: async ({ data }: { data: { identifier: string; tokens: number; refilled_at: Date } }) => {
          rows.set(data.identifier, { ...data });
          return { ...data };
        },
    update: async ({
      where,
      data,
    }: {
      where: { identifier: string };
      data: { tokens: number | { decrement: number }; refilled_at?: Date };
    }) => {
      const row = rows.get(where.identifier);
      if (!row) throw new Error('not found');
      let nextTokens: number;
      let nextRefilled = row.refilled_at;
      if (typeof data.tokens === 'number') {
        nextTokens = data.tokens;
        if (data.refilled_at) nextRefilled = data.refilled_at;
      } else {
        nextTokens = Math.max(0, row.tokens - data.tokens.decrement);
      }
      const updated = { ...row, tokens: nextTokens, refilled_at: nextRefilled };
      rows.set(where.identifier, updated);
      return { ...updated };
    },
      },
    },
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: mocks.prisma as unknown as Record<string, never> }));

import { consumePunchRateLimit } from './rateLimit';

describe('rateLimit', () => {
  it('first request creates bucket and is allowed', async () => {
    mocks.rows.clear();
    const r = await consumePunchRateLimit({ userId: 'u1' });
    expect(r.allowed).toBe(true);
  });

  it('first 5 requests pass, 6th is rejected', async () => {
    mocks.rows.clear();
    for (let i = 0; i < 5; i++) {
      const r = await consumePunchRateLimit({ userId: 'u1' });
      expect(r.allowed).toBe(true);
    }
    const r = await consumePunchRateLimit({ userId: 'u1' });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('refills bucket after 60s window elapses', async () => {
    mocks.rows.clear();
    for (let i = 0; i < 5; i++) {
      await consumePunchRateLimit({ userId: 'u1' });
    }
    const stale = mocks.rows.get('user:u1:punch')!;
    mocks.rows.set('user:u1:punch', {
      ...stale,
      refilled_at: new Date(Date.now() - 70_000),
    });
    const r = await consumePunchRateLimit({ userId: 'u1' });
    expect(r.allowed).toBe(true);
  });

  it('different users have independent buckets', async () => {
    mocks.rows.clear();
    for (let i = 0; i < 5; i++) {
      await consumePunchRateLimit({ userId: 'u1' });
    }
    const r = await consumePunchRateLimit({ userId: 'u2' });
    expect(r.allowed).toBe(true);
  });
});
