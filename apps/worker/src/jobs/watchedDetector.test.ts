import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  overrides: Array<{ user_id: string; date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE' }>;
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
      findMany: async ({ where }: { where: { weekday: number } }) => {
        return store.schedules
          .filter((s) => s.weekday === where.weekday)
          .map((s) => ({ ...s, user: store.users.get(s.user_id)! }));
      },
    },
    scheduleOverride: {
      findMany: async ({ where }: { where: { date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE' } }) => {
        return store.overrides.filter((o) => o.date.getTime() === where.date.getTime() && o.kind === where.kind);
      },
    },
    punch: {
      findFirst: async ({ where }: { where: { user_id: string; at?: { gte: Date; lt: Date } } }) => {
        return store.punches.find((p) => p.user_id === where.user_id && (!where.at || (p.at >= where.at.gte && p.at < where.at.lt))) ?? null;
      },
    },
    flag: {
      findFirst: async ({ where }: { where: { kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; user_id: string; notified_at: Date | null; created_at?: { gte: Date; lt: Date } } }) => {
        return store.flags.find((f) => {
          if (f.kind !== where.kind) return false;
          if (f.user_id !== where.user_id) return false;
          if (where.notified_at !== null && f.notified_at === null) return false;
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
          created_at: new Date('2026-07-12T08:00:00Z'),
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

describe('runWatchedDetector', () => {
  it('creates a Flag row for active user without punch and past start+30min', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T10:00:00+03:00') });
    expect(r.flags_created).toBe(1);
    expect(store.flags.length).toBe(1);
    expect(store.flags[0]!.kind).toBe('WATCHED');
  });

  it('does not create a flag if a punch exists for today', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });
    store.punches.push({ id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-12T08:30:00Z') });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T10:00:00+03:00') });
    expect(r.flags_created).toBe(0);
  });

  it('skips user with approved DAY_OFF override', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });
    store.overrides.push({ user_id: 'u1', date: new Date('2026-07-12T00:00:00.000Z'), kind: 'DAY_OFF' });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T10:00:00+03:00') });
    expect(r.flags_created).toBe(0);
    expect(r.skipped_day_off).toBe(1);
  });

  it('does not duplicate a flag on second run', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });

    const db = makeDb();
    const r1 = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T10:00:00+03:00') });
    expect(r1.flags_created).toBe(1);
    const r2 = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T10:01:00+03:00') });
    expect(r2.flags_created).toBe(0);
  });

  it('does not fire before scheduled start + 30 min', async () => {
    store.users.set('u1', {
      id: 'u1', username: 'emp1', is_active: true, role: 'EMPLOYEE', branch_id: 'b1', branch: { id: 'b1', name: 'Hamra' },
    });
    store.schedules.push({ id: 's1', user_id: 'u1', weekday: 0, start_time: '09:00', end_time: '18:00' });

    const db = makeDb();
    const r = await runWatchedDetector({ db: db as never, now: new Date('2026-07-12T09:15:00+03:00') });
    expect(r.flags_created).toBe(0);
  });
});