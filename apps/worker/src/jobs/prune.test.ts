import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDb, getTestPrisma, seedTestBranch, seedTestUser } from '@/lib/test-helpers/db';
import { runPrune, CALL_KEEP_DAYS, RESOLVED_FLAG_KEEP_DAYS } from './prune';

/*
 * Rows that only matter for a while - replay keys, rate-limit buckets, driver
 * calls, resolved flags - were never deleted, so the tables grew for as long as
 * the shop ran (login alone left a bucket behind for every username anybody
 * typed). Pay history and the audit trail are never touched.
 */
const DAY = 86_400_000;
const now = new Date('2026-09-29T00:40:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('runPrune', () => {
  beforeEach(async () => {
    await cleanDb();
  });
  afterAll(async () => {
    await cleanDb();
  });

  it('deletes what has expired and keeps everything else', async () => {
    expect(CALL_KEEP_DAYS).toBe(90);
    expect(RESOLVED_FLAG_KEEP_DAYS).toBe(180);
    const db = getTestPrisma();
    const branch = await seedTestBranch();
    const user = await seedTestUser({ branch_id: branch.id });

    await db.idempotencyKey.createMany({
      data: [
        { key: 'expired-2d', user_id: user.id, expires_at: ago(2 * DAY) },
        { key: 'expired-1h', user_id: user.id, expires_at: ago(3_600_000) },
        { key: 'live', user_id: user.id, expires_at: new Date(now.getTime() + DAY) },
      ],
    });
    await db.rateLimitBucket.createMany({
      data: [
        { identifier: 'login:account:typo', tokens: 4, refilled_at: ago(2 * DAY) },
        { identifier: 'login:account:recent', tokens: 4, refilled_at: ago(3_600_000) },
      ],
    });
    await db.driverCall.createMany({
      data: [
        { id: 'call-old', driver_id: user.id, caller_id: user.id, created_at: ago(91 * DAY), acknowledged_at: ago(91 * DAY) },
        { id: 'call-old-unanswered', driver_id: user.id, caller_id: user.id, created_at: ago(91 * DAY) },
        { id: 'call-kept', driver_id: user.id, caller_id: user.id, created_at: ago(89 * DAY) },
      ],
    });
    await db.flag.createMany({
      data: [
        { id: 'flag-old-resolved', kind: 'WATCHED', user_id: user.id, context_json: {}, created_at: ago(400 * DAY), resolved_at: ago(181 * DAY) },
        { id: 'flag-recent-resolved', kind: 'WATCHED', user_id: user.id, context_json: {}, created_at: ago(400 * DAY), resolved_at: ago(179 * DAY) },
        { id: 'flag-open', kind: 'MISSED_CHECKOUT', user_id: user.id, context_json: {}, created_at: ago(400 * DAY) },
      ],
    });
    await db.blockedPunchAttempt.create({
      data: {
        user_id: user.id, branch_id: branch.id, at: ago(400 * DAY), open_in_at: ago(401 * DAY),
        lat: 0, lng: 0, accuracy_m: 10, device_fp: 'fp', ip: '127.0.0.1', created_at: ago(400 * DAY),
      },
    });
    await db.auditLog.create({
      data: { actor_id: user.id, action: 'test', entity: 'User', entity_id: user.id, at: ago(400 * DAY) },
    });

    const r = await runPrune({ db, now });

    expect(r).toEqual({ idempotencyKeys: 1, rateLimitBuckets: 1, driverCalls: 2, flags: 1 });
    expect((await db.idempotencyKey.findMany()).map((k) => k.key).sort()).toEqual(['expired-1h', 'live']);
    expect((await db.rateLimitBucket.findMany()).map((b) => b.identifier)).toEqual(['login:account:recent']);
    expect((await db.driverCall.findMany()).map((c) => c.id)).toEqual(['call-kept']);
    expect((await db.flag.findMany()).map((f) => f.id).sort()).toEqual(['flag-open', 'flag-recent-resolved']);
    expect(await db.blockedPunchAttempt.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
  });
});
