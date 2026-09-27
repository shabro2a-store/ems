import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDb, seedTestUser } from '../test-helpers/db';
import { readIdempotentResponse, storeIdempotentResponse } from './idempotency';

/*
 * #23: the Idempotency-Key was read, the work done, then the answer stored -
 * so two requests with the same key both read "nothing yet" and both did the
 * work. And the client minted a fresh key per attempt anyway. On the server
 * side the key is now CLAIMED before any work, in one insert Postgres
 * serialises: exactly one request with a key goes ahead.
 */
describe('claiming an idempotency key', () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDb();
    userId = (await seedTestUser({ username: 'idem-user' })).id;
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  const scope = '/api/admin/adjustments';

  it('lets exactly one of many simultaneous requests go ahead', async () => {
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => readIdempotentResponse({ userId, key: 'k-burst', scope })),
    );
    expect(answers.filter((a) => a === null)).toHaveLength(1);
    for (const a of answers.filter((x) => x !== null)) {
      expect(a!.status_code).toBe(409);
      expect((a!.response_json as { error: { code: string } }).error.code).toBe('IN_PROGRESS');
    }
  });

  it('replays the answer once the first request has finished', async () => {
    expect(await readIdempotentResponse({ userId, key: 'k-done', scope })).toBeNull();
    await storeIdempotentResponse({ userId, key: 'k-done', scope, status_code: 200, response_json: { ok: true, data: { n: 1 } } });
    expect(await readIdempotentResponse({ userId, key: 'k-done', scope })).toEqual({
      status_code: 200,
      response_json: { ok: true, data: { n: 1 } },
    });
  });

  it('refuses a key already used for a different route', async () => {
    await readIdempotentResponse({ userId, key: 'k-other', scope });
    await storeIdempotentResponse({ userId, key: 'k-other', scope, status_code: 200, response_json: { ok: true, data: {} } });
    const answer = await readIdempotentResponse({ userId, key: 'k-other', scope: '/api/me/advances' });
    expect(answer!.status_code).toBe(409);
    expect((answer!.response_json as { error: { code: string } }).error.code).toBe('KEY_REUSED');
  });

  it('lets a claim that was abandoned mid-way be taken over after the lease', async () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(await readIdempotentResponse({ userId, key: 'k-stale', scope }, now)).toBeNull();
    // Nothing stored: the request that claimed it failed before answering.
    const soon = new Date(now.getTime() + 10_000);
    expect((await readIdempotentResponse({ userId, key: 'k-stale', scope }, soon))!.status_code).toBe(409);
    const later = new Date(now.getTime() + 2 * 60_000);
    expect(await readIdempotentResponse({ userId, key: 'k-stale', scope }, later)).toBeNull();
  });

  it("keeps one person's key apart from another's", async () => {
    const other = (await seedTestUser({ username: 'idem-other' })).id;
    expect(await readIdempotentResponse({ userId, key: 'k-shared', scope })).toBeNull();
    await storeIdempotentResponse({ userId, key: 'k-shared', scope, status_code: 200, response_json: { ok: true, data: { who: 1 } } });
    expect(await readIdempotentResponse({ userId: other, key: 'k-shared', scope })).toBeNull();
  });

  it('treats an expired answer as never given', async () => {
    const now = new Date('2026-10-01T10:00:00Z');
    await readIdempotentResponse({ userId, key: 'k-old', scope }, now);
    await storeIdempotentResponse({ userId, key: 'k-old', scope, status_code: 200, response_json: { ok: true, data: {} } }, now);
    const nextDay = new Date(now.getTime() + 25 * 3_600_000);
    expect(await readIdempotentResponse({ userId, key: 'k-old', scope }, nextDay)).toBeNull();
  });
});
