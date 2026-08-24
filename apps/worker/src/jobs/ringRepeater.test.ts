import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ userId: string; ring?: boolean; attempt?: number }> = [];

vi.mock('notify', () => ({
  sendPushToUser: async (
    userId: string,
    payload: { ring?: boolean; attempt?: number },
  ) => {
    sent.push({ userId, ring: payload.ring, attempt: payload.attempt });
  },
}));

import { RING_WINDOW_MS as WEB_RING_WINDOW_MS } from '@/lib/services/caller';
import { runRingRepeater, RING_REPEAT_WINDOW_MS } from './ringRepeater';

type CallRow = { id: string; driver_id: string; created_at: Date; acknowledged_at: Date | null };

const store: { calls: CallRow[] } = { calls: [] };

function makeDb() {
  return {
    driverCall: {
      findMany: async ({
        where,
      }: {
        where: { acknowledged_at: null; created_at: { gte: Date } };
      }) =>
        store.calls.filter(
          (c) => c.acknowledged_at === null && c.created_at >= where.created_at.gte,
        ),
    },
    pushSubscription: { findMany: async () => [], delete: async () => ({}) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const RANG_AT = new Date('2026-08-24T10:00:00Z');
const at = (sec: number) => new Date(RANG_AT.getTime() + sec * 1000);

function seedCall(over: Partial<CallRow> = {}) {
  store.calls.push({
    id: `c${store.calls.length + 1}`,
    driver_id: 'd1',
    created_at: RANG_AT,
    acknowledged_at: null,
    ...over,
  });
}

beforeEach(() => {
  store.calls.length = 0;
  sent.length = 0;
});

describe('runRingRepeater', () => {
  it('gives up at the same moment the app does', async () => {
    // If the pushes outlasted the in-app alarm, a driver holding an open app
    // would watch the alarm screen vanish while the phone kept buzzing; if the
    // app outlasted the pushes, the screen would flash in silence.
    expect(RING_REPEAT_WINDOW_MS).toBe(WEB_RING_WINDOW_MS);
  });

  it('keeps pushing an unanswered ring, tick after tick', async () => {
    // One push was the entire alert before this: a driver with the phone in a
    // pocket missed it and nothing else ever happened.
    seedCall();
    for (const sec of [5, 10, 15, 20]) {
      await runRingRepeater({ db: makeDb(), now: at(sec) });
    }
    expect(sent).toHaveLength(4);
    expect(sent.every((s) => s.userId === 'd1' && s.ring === true)).toBe(true);
  });

  it('stops the instant the driver answers', async () => {
    seedCall();
    expect((await runRingRepeater({ db: makeDb(), now: at(5) })).repushed).toBe(1);
    store.calls[0]!.acknowledged_at = at(7);
    expect((await runRingRepeater({ db: makeDb(), now: at(10) })).repushed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('is still ringing minutes later if nobody has answered', async () => {
    // The owner's rule: it rings until the driver shuts it off. Two minutes in,
    // where the old 45-second window had long since given up, it is still going.
    seedCall();
    expect((await runRingRepeater({ db: makeDb(), now: at(120) })).repushed).toBe(1);
  });

  it('stops at the backstop, for the phone that never answers at all', async () => {
    // Not the length of the ring - the point where a handset switched off or
    // shut in a drawer overnight stops collecting twelve alerts a minute.
    seedCall();
    const justInside = RING_REPEAT_WINDOW_MS / 1000 - 1;
    expect((await runRingRepeater({ db: makeDb(), now: at(justInside) })).repushed).toBe(1);
    expect((await runRingRepeater({ db: makeDb(), now: at(justInside + 5) })).repushed).toBe(0);
  });

  it('rings every waiting driver, not just the first', async () => {
    seedCall({ driver_id: 'd1' });
    seedCall({ driver_id: 'd2' });
    await runRingRepeater({ db: makeDb(), now: at(5) });
    expect(sent.map((s) => s.userId).sort()).toEqual(['d1', 'd2']);
  });

  it('counts the attempts up so the payload is never identical', async () => {
    seedCall();
    await runRingRepeater({ db: makeDb(), now: at(5) });
    await runRingRepeater({ db: makeDb(), now: at(20) });
    expect(sent[0]!.attempt).toBeLessThan(sent[1]!.attempt!);
  });
});
