import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb } from '../test-helpers/db';
import { consumeRateLimit, consumePunchRateLimit } from './rateLimit';
import { consumeTripRateLimit } from './rateLimitTrip';
import { consumeAdvanceRateLimit } from './rateLimitAdvance';

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

/*
 * The punch, trip-start and advance limiters still read, then created or
 * updated the bucket. Two taps at once both found no bucket and both inserted
 * one; the second insert failed, and the trip start that should have been a
 * refusal came back as a server error (found through #40's double-tap test).
 */
describe.each([
  ['punch', consumePunchRateLimit],
  ['trip start', consumeTripRateLimit],
  ['advance', consumeAdvanceRateLimit],
] as const)('the %s limit', (_name, consume) => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('lets five of ten simultaneous attempts through, and fails none', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => consume({ userId: 'burst-user' })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('keeps one person apart from another', async () => {
    for (let i = 0; i < 5; i++) await consume({ userId: 'busy' });
    expect((await consume({ userId: 'busy' })).allowed).toBe(false);
    expect((await consume({ userId: 'quiet' })).allowed).toBe(true);
  });
});
