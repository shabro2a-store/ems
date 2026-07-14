import { describe, it, expect, beforeEach } from 'vitest';

type FlagRow = {
  id: string;
  kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD';
  user_id: string | null;
  branch_id: string | null;
  context_json: unknown;
  created_at: Date;
  notified_at: Date | null;
};
type UserRow = { id: string; username: string };

const store: {
  flags: FlagRow[];
  users: Map<string, UserRow>;
  notifications: Array<{ template: string; context: unknown }>;
} = {
  flags: [],
  users: new Map(),
  notifications: [],
};

import { runEndOfDayWatcher } from './endOfDayWatcher';

function resetStore() {
  store.flags.length = 0;
  store.users.clear();
  store.notifications.length = 0;
}

function makeDb() {
  return {
    flag: {
      findMany: async ({ where }: { where: { kind: string; notified_at: Date | null } }) => {
        return store.flags
          .filter((f) => f.kind === where.kind && f.notified_at === where.notified_at)
          .map((f) => ({ ...f, user: f.user_id ? store.users.get(f.user_id) : undefined }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ notified_at: Date | null }> }) => {
        const f = store.flags.find((x) => x.id === where.id);
        if (!f) throw new Error('not found');
        Object.assign(f, data);
        return f;
      },
    },
  };
}

beforeEach(() => {
  resetStore();
});

const notifier = {
  send: async (payload: { channel: string; recipient: string; template: string; context: unknown }) => {
    store.notifications.push(payload);
  },
};

describe('runEndOfDayWatcher', () => {
  it('sends notification for each unresolved WATCHED flag and marks notified_at', async () => {
    store.users.set('u1', { id: 'u1', username: 'emp1' });
    store.flags.push({
      id: 'f1',
      kind: 'WATCHED',
      user_id: 'u1',
      branch_id: 'b1',
      context_json: { scheduled_start: '09:00' },
      created_at: new Date('2026-07-12T09:30:00Z'),
      notified_at: null,
    });
    store.flags.push({
      id: 'f2',
      kind: 'WATCHED',
      user_id: 'u1',
      branch_id: 'b1',
      context_json: { scheduled_start: '09:00' },
      created_at: new Date('2026-07-12T09:30:00Z'),
      notified_at: null,
    });

    const db = makeDb();
    const r = await runEndOfDayWatcher({ db: db as never, notifier });
    expect(r.notified).toBe(2);
    expect(store.flags[0]!.notified_at).not.toBeNull();
    expect(store.flags[1]!.notified_at).not.toBeNull();
  });

  it('skips flags that already have notified_at set', async () => {
    store.flags.push({
      id: 'f1',
      kind: 'WATCHED',
      user_id: 'u1',
      branch_id: 'b1',
      context_json: {},
      created_at: new Date(),
      notified_at: new Date(),
    });

    const db = makeDb();
    const r = await runEndOfDayWatcher({ db: db as never, notifier });
    expect(r.notified).toBe(0);
  });
});