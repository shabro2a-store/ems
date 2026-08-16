import { describe, it, expect, beforeEach } from 'vitest';

type FlagRow = {
  id: string;
  kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD';
  user_id: string | null;
  branch_id: string | null;
  context_json: unknown;
  created_at: Date;
  notified_at: Date | null;
  resolved_at: Date | null;
};
type ScheduleRow = { id: string; user_id: string; weekday: number; shift_min: number | null };
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
  overrides: Array<{ user_id: string; date: Date; kind: 'DAY_OFF' | 'HOURS_CHANGE'; shift_min: number | null }>;
  flagSeq: number;
} = {
  flags: [],
  schedules: [],
  users: new Map(),
  punches: [],
  overrides: [],
  flagSeq: 0,
};

import { runWatchedDetector } from './watchedDetector';

function resetStore() {
  store.flags.length = 0;
  store.schedules.length = 0;
  store.users.clear();
  store.punches.length = 0;
  store.overrides.length = 0;
  store.flagSeq = 0;
}

function makeDb() {
  return {
    schedule: {
      findMany: async ({ where }: { where: { weekday: number; shift_min?: { gt: number } } }) => {
        return store.schedules
          .filter((s) => s.weekday === where.weekday)
          .filter((s) => !where.shift_min || (s.shift_min != null && s.shift_min > where.shift_min.gt))
          .map((s) => ({ ...s, user: store.users.get(s.user_id)! }));
      },
    },
    scheduleOverride: {
      findMany: async ({ where }: { where: { date: Date; kind?: 'DAY_OFF' | 'HOURS_CHANGE' } }) => {
        return store.overrides.filter(
          (o) => o.date.getTime() === where.date.getTime() && (!where.kind || o.kind === where.kind),
        );
      },
    },
    punch: {
      findFirst: async ({ where }: { where: { user_id: string; at?: { gte: Date; lt: Date } } }) => {
        return store.punches.find((p) => p.user_id === where.user_id && (!where.at || (p.at >= where.at.gte && p.at < where.at.lt))) ?? null;
      },
    },
    flag: {
      findFirst: async ({ where }: { where: { kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; user_id: string; created_at?: { gte: Date; lt: Date } } }) => {
        return store.flags.find((f) => {
          if (f.kind !== where.kind) return false;
          if (f.user_id !== where.user_id) return false;
          if (where.created_at && (f.created_at < where.created_at.gte || f.created_at >= where.created_at.lt)) return false;
          return true;
        }) ?? null;
      },
      create: async ({ data }: { data: { kind: 'WATCHED'; user_id: string; branch_id: string | null; context_json: unknown } }) => {
        store.flagSeq += 1;
        const f: FlagRow = {
          id: `f${store.flagSeq}`,
          kind: data.kind,
          user_id: data.user_id,
          branch_id: data.branch_id,
          context_json: data.context_json,
          created_at: new Date('2026-07-12T10:00:00Z'),
          notified_at: null,
          resolved_at: null,
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

// All fixtures judge Sunday 2026-07-12 (Beirut weekday 0) as "yesterday" by
// running the job just after midnight on Monday 2026-07-13.
const AFTER_MIDNIGHT = new Date('2026-07-13T00:10:00+03:00');

describe('runWatchedDetector', () => {
  it('flags an active user scheduled yesterday with zero punches that day', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(1);
    expect(r.users_scanned).toBe(1);
    expect(store.flags[0]!.kind).toBe('WATCHED');
    expect(store.flags[0]!.context_json).toEqual({ shift_min: 480, date: '2026-07-12' });
  });

  it('does not flag when a punch exists in that Beirut day', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-12T09:00:00+03:00') });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(0);
  });

  it('skips a user with an approved DAY_OFF override for that date', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.overrides.push({ user_id: 'u1', date: new Date('2026-07-12T00:00:00.000Z'), kind: 'DAY_OFF', shift_min: null });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(0);
    expect(r.skipped_off).toBe(1);
  });

  it('skips a user whose whole shift was approved as time off (HOURS_CHANGE resolving to zero)', async () => {
    // decideLeave writes HOURS_CHANGE with shift_min = max(0, weekday - off_min),
    // which is 0 when the employee asked for their whole shift off. Filtering on
    // kind DAY_OFF alone missed that and raised an absence flag - plus a Telegram
    // alert - for leave the owner had just approved.
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.overrides.push({ user_id: 'u1', date: new Date('2026-07-12T00:00:00.000Z'), kind: 'HOURS_CHANGE', shift_min: 0 });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(0);
    expect(r.skipped_off).toBe(1);
    expect(store.flags).toHaveLength(0);
  });

  it('still flags a partial time-off day, and reports the hours actually owed', async () => {
    // Half the shift off still leaves half a shift to turn up for. The notice
    // must quote the 4h that were owed, not the 8h weekly value.
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });
    store.overrides.push({ user_id: 'u1', date: new Date('2026-07-12T00:00:00.000Z'), kind: 'HOURS_CHANGE', shift_min: 240 });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.flags_created).toBe(1);
    expect(r.skipped_off).toBe(0);
    expect(store.flags[0]!.context_json).toEqual({ shift_min: 240, date: '2026-07-12' });
  });

  it('does not flag when shift_min is zero', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 0 });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.users_scanned).toBe(0);
    expect(r.flags_created).toBe(0);
  });

  it('does not flag when shift_min is absent (null)', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: null });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r.users_scanned).toBe(0);
    expect(r.flags_created).toBe(0);
  });

  it('does not duplicate a flag on second run', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });

    const db = makeDb();
    const r1 = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(r1.flags_created).toBe(1);
    const r2 = await runWatchedDetector({ db: db as never, now: new Date('2026-07-13T00:11:00+03:00') });
    expect(r2.flags_created).toBe(0);
  });

  it('does not re-raise a flag the admin already dismissed', async () => {
    // Regression: the dedup guard used to require an unresolved flag, so
    // dismissing one made it stop matching and the next run created a
    // duplicate. From the admin's side the notice came back by itself.
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, shift_min: 480 });

    const db = makeDb();
    const first = await runWatchedDetector({ db: db as never, now: AFTER_MIDNIGHT });
    expect(first.flags_created).toBe(1);

    store.flags[0]!.resolved_at = new Date('2026-07-13T00:10:30+03:00');

    const after = await runWatchedDetector({ db: db as never, now: new Date('2026-07-13T00:11:00+03:00') });
    expect(after.flags_created).toBe(0);
    expect(store.flags.length).toBe(1);
  });
});
