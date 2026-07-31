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
type ScheduleRow = { id: string; user_id: string; weekday: number; start_time: string; end_time: string };
type UserRow = {
  id: string;
  username: string;
  is_active: boolean;
  role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
  branch_id: string | null;
  branch: { id: string; name: string } | null;
};
type PunchRow = { id: string; user_id: string; kind: 'IN' | 'OUT'; at: Date };

const store: {
  flags: FlagRow[];
  schedules: ScheduleRow[];
  users: Map<string, UserRow>;
  punches: PunchRow[];
  flagSeq: number;
  notifications: Array<{ channel: string; recipient: string; template: string; context: unknown }>;
} = {
  flags: [],
  schedules: [],
  users: new Map(),
  punches: [],
  flagSeq: 0,
  notifications: [],
};

import { runMissedCheckout } from './missedCheckout';

function resetStore() {
  store.flags.length = 0;
  store.schedules.length = 0;
  store.users.clear();
  store.punches.length = 0;
  store.flagSeq = 0;
  store.notifications.length = 0;
}

function makeDb() {
  return {
    schedule: {
      findMany: async ({ where }: { where: { weekday: number | { in: number[] } } }) => {
        const wds = typeof where.weekday === 'number' ? [where.weekday] : where.weekday.in;
        return store.schedules
          .filter((s) => wds.includes(s.weekday))
          .map((s) => ({ ...s, user: store.users.get(s.user_id)! }));
      },
    },
    scheduleOverride: {
      findMany: async () => [] as unknown[],
    },
    punch: {
      findFirst: async ({ where }: { where: { user_id: string; kind: 'IN' | 'OUT'; at?: { gt?: Date } } }) => {
        const candidates = store.punches.filter((p) => p.user_id === where.user_id && p.kind === where.kind);
        if (where.at?.gt) {
          return candidates.filter((p) => p.at > (where.at?.gt as Date)).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
        }
        return candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
      },
    },
    flag: {
      findFirst: async ({ where }: { where: { kind: string; user_id: string; created_at: { gte: Date } } }) => {
        return store.flags.find((f) =>
          f.kind === where.kind && f.user_id === where.user_id && f.created_at >= where.created_at.gte,
        ) ?? null;
      },
      create: async ({ data }: { data: { kind: 'MISSED_CHECKOUT'; user_id: string; branch_id: string | null; context_json: unknown } }) => {
        store.flagSeq += 1;
        const f: FlagRow = {
          id: `f${store.flagSeq}`,
          kind: data.kind,
          user_id: data.user_id,
          branch_id: data.branch_id,
          context_json: data.context_json,
          created_at: new Date('2026-07-12T18:00:00Z'),
          notified_at: null,
        };
        store.flags.push(f);
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

describe('runMissedCheckout', () => {
  it('creates Flag and sends neutral message when still clocked in past end+35', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-12T09:00:00+03:00') });

    const db = makeDb();
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T18:36:00+03:00'), notifier });
    expect(r.flags_created).toBe(1);
    expect(r.notified).toBe(1);
    expect(store.notifications[0]!.template).toBe('missed_checkout');
    expect(store.notifications[0]!.context).toHaveProperty('message');
  });

  it('handles an overnight shift ending this morning (yesterday 20:00 → today 05:00)', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'drv1', is_active: true, role: 'DRIVER', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    // Saturday (weekday 6) overnight shift into Sunday.
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 6, start_time: '20:00', end_time: '05:00' });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-11T20:00:00+03:00') });

    const db = makeDb();
    // Sunday 05:40 — 40 min past the 05:00 end, still clocked in.
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T05:40:00+03:00'), notifier });
    expect(r.flags_created).toBe(1);
    expect(r.notified).toBe(1);
  });

  it('does not fire if user punched OUT', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-12T09:00:00+03:00') },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-12T18:00:00+03:00') },
    );

    const db = makeDb();
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T18:36:00+03:00'), notifier });
    expect(r.flags_created).toBe(0);
  });

  it('does not duplicate flag on second run', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-12T09:00:00+03:00') });

    const db = makeDb();
    const r1 = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T18:36:00+03:00'), notifier });
    expect(r1.flags_created).toBe(1);
    const r2 = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T18:37:00+03:00'), notifier });
    expect(r2.flags_created).toBe(0);
  });
});