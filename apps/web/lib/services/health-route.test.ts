import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();
vi.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

import { GET } from '@/app/api/health/route';
import { HEALTH_DB_TIMEOUT_MS } from '@/lib/services/dbPing';

/*
 * /api/health is what the container healthcheck and the deploy checklist read.
 * It used to answer ok without touching anything, so a web container that had
 * lost its database - wrong password after a rotation, Postgres down - still
 * showed "healthy" while every real request failed.
 */
describe('GET /api/health', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('is ok when the database answers', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.uptime_s).toBe('number');
  });

  it('is 503 when the database refuses', async () => {
    queryRaw.mockRejectedValue(new Error('password authentication failed for user "ems"'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: { code: 'DB_UNREACHABLE', message: 'Database unreachable' } });
  });

  it('is 503 when the database does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      queryRaw.mockReturnValue(new Promise(() => undefined));
      const pending = GET();
      await vi.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS + 1);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});
