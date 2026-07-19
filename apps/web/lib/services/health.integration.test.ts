import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('GET /api/health', () => {
  it('returns 200 with ok:true, uptime_s, and version', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: { uptime_s: number; version: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.data?.uptime_s).toBe('number');
    expect(body.data?.uptime_s).toBeGreaterThanOrEqual(0);
    expect(typeof body.data?.version).toBe('string');
  });

  it('does not require auth (public endpoint)', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
