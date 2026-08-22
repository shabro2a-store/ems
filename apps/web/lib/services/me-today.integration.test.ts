import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { todayInBeirut, todayInBeirutDateRange } from 'time';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestPunch } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

interface TodayPayload {
  in_at: string | null;
  minutes_since_in: number | null;
  minutes_today: number;
  hours_month: number;
}

const MIN = 60 * 1000;

async function today(session: { cookies: string; csrf: string }): Promise<TodayPayload> {
  const res = await fetch(`${BASE_URL}/api/me/today`, {
    headers: { Cookie: session.cookies, 'X-CSRF-Token': session.csrf },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: TodayPayload };
  expect(body.ok).toBe(true);
  return body.data;
}

// Anchored to this Beirut day's midnight rather than to "now", so the totals
// are exact whatever hour the suite runs at.
function dayAnchor(): Date {
  return todayInBeirutDateRange(todayInBeirut()).startUtc;
}

describe('GET /api/me/today: the day total (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('counts the whole day, not just the session that is open now', async () => {
    // Punch in, out five minutes later, straight back in: 5 + 110 = 115 minutes
    // worked. The tile labelled "Today" used to render minutes_since_in, so it
    // read 110 and the first session simply vanished.
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'today-two-sessions', branch_id: branch.id });
    const start = dayAnchor();
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(start.getTime() + 60 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date(start.getTime() + 65 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(start.getTime() + 65 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date(start.getTime() + 175 * MIN) });

    const session = await loginAs(emp.username, 'change-me');
    const data = await today(session);

    expect(data.minutes_today).toBe(115);
    // Nothing is open, so the old source for the tile would have shown zero.
    expect(data.in_at).toBeNull();
    expect(data.minutes_since_in).toBeNull();
  });

  it('adds the open session to what is already banked, rather than replacing it', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'today-open-session', branch_id: branch.id });
    const start = dayAnchor();
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(start.getTime() + 60 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date(start.getTime() + 65 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(start.getTime() + 65 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'OUT', at: new Date(start.getTime() + 175 * MIN) });
    await seedTestPunch({ user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(start.getTime() + 180 * MIN) });

    const session = await loginAs(emp.username, 'change-me');
    const data = await today(session);

    expect(data.in_at).not.toBeNull();
    expect(data.minutes_today).toBe((data.minutes_since_in ?? 0) + 115);
    // The driver's "On shift" tile still needs the current session on its own.
    expect(Number.isInteger(data.minutes_since_in)).toBe(true);
  });

  it('keeps an overnight shift on its own day past midnight', async () => {
    // Arrived 21:00 Beirut yesterday and still here. The day total must keep
    // climbing rather than resetting when the calendar day turned over.
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'today-overnight', branch_id: branch.id });
    const start = dayAnchor();
    await seedTestPunch({
      user_id: emp.id,
      branch_id: branch.id,
      kind: 'IN',
      at: new Date(start.getTime() - 180 * MIN),
    });

    const session = await loginAs(emp.username, 'change-me');
    const data = await today(session);

    expect(data.minutes_today).toBeGreaterThanOrEqual(180);
    expect(data.minutes_today).toBe(data.minutes_since_in);
  });
});
