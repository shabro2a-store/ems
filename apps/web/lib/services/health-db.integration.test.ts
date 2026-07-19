import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('GET /api/health/db', () => {
  afterAll(async () => {
    await new PrismaClient().$disconnect();
  });

  it('returns 200 with latency_ms when DB is reachable', async () => {
    const res = await fetch(`${BASE_URL}/api/health/db`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: { latency_ms: number } };
    expect(body.ok).toBe(true);
    expect(typeof body.data?.latency_ms).toBe('number');
    expect(body.data?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not require auth (public endpoint)', async () => {
    const res = await fetch(`${BASE_URL}/api/health/db`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
