import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb } from '../test-helpers/db';
import { consumeRateLimit } from './rateLimit';

/*
 * The buckets were read, then written: twenty attempts fired at once all read
 * "5 left" before any of them wrote, and all twenty went through. One statement
 * per attempt, which Postgres serialises on the row, is the whole fix.
 */
describe('consumeRateLimit', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('lets exactly the limit through when attempts arrive at once', async () => {
    const now = new Date('2026-10-01T10:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(getTestPrisma(), 'burst', 5, 60_000, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('refills once the window has passed', async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 5; i++) await consumeRateLimit(getTestPrisma(), 'refill', 5, 60_000, t0);
    expect((await consumeRateLimit(getTestPrisma(), 'refill', 5, 60_000, new Date(t0.getTime() + 30_000))).allowed).toBe(false);
    expect((await consumeRateLimit(getTestPrisma(), 'refill', 5, 60_000, new Date(t0.getTime() + 61_000))).allowed).toBe(true);
  });

  it('says how long until the next attempt is allowed', async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 2; i++) await consumeRateLimit(getTestPrisma(), 'wait', 2, 15 * 60_000, t0);
    const refused = await consumeRateLimit(getTestPrisma(), 'wait', 2, 15 * 60_000, new Date(t0.getTime() + 5 * 60_000));
    expect(refused).toEqual({ allowed: false, retryAfterSec: 600 });
  });
});
