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
type ScheduleRow = { id: string; user_id: string; weekday: number; shift_min: number | null };
type UserRow = {
  id: string;
  username: string;
  is_active: boolean;
  role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
  branch_id: string | null;
  branch: { id: string; name: string; overtime_grace_min: number } | null;
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
      findMany: async ({ where }: { where: { shift_min?: { gt: number } } }) => {
        return store.schedules
          .filter((s) => !where.shift_min || (s.shift_min != null && s.shift_min > where.shift_min.gt))
          .map((s) => ({ ...s, user: store.users.get(s.user_id)! }));
      },
    },
    punch: {
      findFirst: async ({ where, orderBy }: { where: { user_id: string; kind: 'IN' | 'OUT'; at?: { gt?: Date } }; orderBy?: { at: 'desc' } }) => {
        const candidates = store.punches.filter((p) => p.user_id === where.user_id && p.kind === where.kind);
        if (where.at?.gt) {
          return candidates.filter((p) => p.at > (where.at?.gt as Date)).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
        }
        if (orderBy) {
          return candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
        }
        return candidates[0] ?? null;
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

// A Sunday (Beirut weekday 0) check-in at 09:00, 8h shift_min (480) and the
// branch's default 15 min grace put the trigger point at elapsed > 495 min,
// i.e. strictly after 17:15.
const CHECK_IN = new Date('2026-07-12T09:00:00+03:00');

describe('runMissedCheckout', () => {
  it('fires once elapsed exceeds shift_min plus branch grace', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra', overtime_grace_min: 15 },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN });

    const db = makeDb();
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:16:00+03:00'), notifier });
    expect(r.flags_created).toBe(1);
    expect(r.notified).toBe(1);
    expect(store.flags[0]!.context_json).toEqual({ shift_min: 480, over_min: 16 });
    expect(store.notifications[0]!.template).toBe('missed_checkout');
    expect((store.notifications[0]!.context as { message: string }).message).toContain('8h shift');
  });

  it('does not fire at or before shift_min plus grace', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra', overtime_grace_min: 15 },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN });

    const db = makeDb();
    // Exactly 495 minutes elapsed (480 + 15) - the boundary must not fire.
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:15:00+03:00'), notifier });
    expect(r.flags_created).toBe(0);
  });

  it('does not fire once the employee has punched OUT', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra', overtime_grace_min: 15 },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-12T18:00:00+03:00') },
    );

    const db = makeDb();
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T20:00:00+03:00'), notifier });
    expect(r.flags_created).toBe(0);
  });

  it('does not duplicate a flag on second run the same day', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra', overtime_grace_min: 15 },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN });

    const db = makeDb();
    const r1 = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:16:00+03:00'), notifier });
    expect(r1.flags_created).toBe(1);
    const r2 = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:20:00+03:00'), notifier });
    expect(r2.flags_created).toBe(0);
  });

  it('falls back to 15 minutes of grace when the user has no branch', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: null, branch: null,
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN });

    const db = makeDb();
    // 481 elapsed: over the 480 shift but still inside a 15 min default grace.
    const before = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:01:00+03:00'), notifier });
    expect(before.flags_created).toBe(0);

    // 496 elapsed: past shift + default grace.
    const after = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T17:16:00+03:00'), notifier });
    expect(after.flags_created).toBe(1);
    expect(store.notifications[0]!.context).toHaveProperty('branch', null);
  });

  it('judges elapsed against the schedule for the weekday the check-in started, not a different weekday row', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra', overtime_grace_min: 15 },
    });
    // Sunday shift_min is generous (480); Monday's is short (60). The check-in
    // is Sunday, so only Sunday's threshold (495) should ever apply to it.
    store.schedules.push(
      { id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 },
      { id: 's2', user_id: 'u1', weekday: 1, shift_min: 60 },
    );
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: CHECK_IN });

    const db = makeDb();
    // 90 min elapsed: past Monday's 60+15 threshold but nowhere near Sunday's.
    const r = await runMissedCheckout({ db: db as never, now: new Date('2026-07-12T10:30:00+03:00'), notifier });
    expect(r.flags_created).toBe(0);
  });
});
