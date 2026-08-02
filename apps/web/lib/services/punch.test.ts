import { describe, it, expect, vi, beforeEach } from 'vitest';

type Store = {
  users: Map<string, {
    id: string;
    username: string;
    is_active: boolean;
    role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
    branch_id: string;
    branch: {
      id: string;
      name: string;
      lat: number;
      lng: number;
      gps_radius_m: number;
      gps_accuracy_max_m: number;
      absent_grace_min: number;
      trip_threshold_min: number;
      is_active: boolean;
    };
    hourly_rate_cent: number;
    password_hash: string;
    telegram_chat_id: string | null;
    notify_daily_summary: boolean;
    notify_routine_pings: boolean;
    created_at: Date;
  }>;
  branches: Map<string, {
    id: string;
    name: string;
    lat: number;
    lng: number;
    gps_radius_m: number;
    gps_accuracy_max_m: number;
    absent_grace_min: number;
    trip_threshold_min: number;
    is_active: boolean;
  }>;
  punches: Array<{
    id: string;
    user_id: string;
    branch_id: string;
    kind: 'IN' | 'OUT';
    at: Date;
    lat: number;
    lng: number;
    accuracy_m: number;
    device_fp: string;
    ip: string;
    corrected: boolean;
    corrected_by: string | null;
    correction_reason: string | null;
    created_at: Date;
  }>;
  overrides: Array<{ id: string; user_id: string; date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE' }>;
  trips: Array<{ id: string; driver_id: string; back_at: Date | null }>;
  audits: Array<{ id: string }>;
  flags: Array<{ id: string; user_id: string; kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; notified_at: Date | null; context_json: unknown; created_at: Date }>;
  punchSeq: number;
  auditSeq: number;
};

const store: Store = {
  users: new Map(),
  branches: new Map(),
  punches: [],
  overrides: [],
  trips: [],
  audits: [],
  flags: [],
  punchSeq: 0,
  auditSeq: 0,
};

const mocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  scheduleOverride: { findUnique: vi.fn() },
  trip: { findFirst: vi.fn() },
  punch: { findFirst: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  flag: { findFirst: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('@/lib/db/prisma', () => ({
  prisma: mocks as unknown as Record<string, unknown>,
}));

import { punchEmployee } from './punch';

function resetStore() {
  store.users.clear();
  store.branches.clear();
  store.punches.length = 0;
  store.overrides.length = 0;
  store.trips.length = 0;
  store.audits.length = 0;
  store.flags.length = 0;
  store.punchSeq = 0;
  store.auditSeq = 0;
}

function makeBranch(partial: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'Hamra',
    lat: 33.8962,
    lng: 35.4827,
    gps_radius_m: 50,
    gps_accuracy_max_m: 100,
    absent_grace_min: 15,
    trip_threshold_min: 30,
    is_active: true,
    ...partial,
  };
}

function makeUser(id: string, branch: ReturnType<typeof makeBranch>, role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' = 'EMPLOYEE') {
  return {
    id,
    username: id,
    is_active: true,
    role,
    branch_id: branch.id,
    branch,
    hourly_rate_cent: 200,
    password_hash: 'x',
    telegram_chat_id: null as string | null,
    notify_daily_summary: true,
    notify_routine_pings: true,
    created_at: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();

  mocks.user.findUnique.mockImplementation(async ({ where, include }: { where: { id: string }; include?: { branch: true } }) => {
    const u = store.users.get(where.id);
    if (!u) return null;
    if (include?.branch) return u;
    const { branch: _b, ...rest } = u;
    return rest;
  });

  mocks.scheduleOverride.findUnique.mockImplementation(async ({ where }: { where: { user_id_date: { user_id: string; date: Date } } }) => {
    return (
      store.overrides.find(
        (o) =>
          o.user_id === where.user_id_date.user_id &&
          o.date.getTime() === where.user_id_date.date.getTime(),
      ) ?? null
    );
  });

  mocks.trip.findFirst.mockImplementation(async ({ where }: { where: { driver_id: string; back_at: null } }) => {
    return store.trips.find((t) => t.driver_id === where.driver_id && t.back_at === null) ?? null;
  });

  mocks.punch.findFirst.mockImplementation(async ({ where, orderBy }: { where: { user_id: string; kind: 'IN' | 'OUT'; at?: { gt: Date } }; orderBy?: { at: 'asc' | 'desc' } }) => {
    const filtered = store.punches
      .filter((p) => p.user_id === where.user_id && p.kind === where.kind)
      .filter((p) => (where.at?.gt ? p.at > where.at.gt : true))
      .sort((a, b) =>
        orderBy?.at === 'desc' ? b.at.getTime() - a.at.getTime() : a.at.getTime() - b.at.getTime(),
      );
    return filtered[0] ?? null;
  });

  mocks.punch.create.mockImplementation(async ({ data }: { data: { user_id: string; branch_id: string; kind: 'IN' | 'OUT'; at: Date; lat: number; lng: number; accuracy_m: number; device_fp: string; ip: string } }) => {
    store.punchSeq += 1;
    const p = {
      id: `p${store.punchSeq}`,
      ...data,
      corrected: false,
      corrected_by: null,
      correction_reason: null,
      created_at: new Date(),
    };
    store.punches.push(p);
    return p;
  });

  mocks.auditLog.create.mockImplementation(async () => {
    store.auditSeq += 1;
    const a = { id: `a${store.auditSeq}` };
    store.audits.push(a);
    return a;
  });

  mocks.flag.findFirst.mockImplementation(async ({ where }: { where: { kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; user_id: string; notified_at: Date | null; orderBy?: { created_at: 'asc' | 'desc' } } }) => {
    const found = store.flags
      .filter((f) => f.kind === where.kind && f.user_id === where.user_id && f.notified_at === where.notified_at)
      .sort((a, b) => (where.orderBy?.created_at === 'desc' ? b.created_at.getTime() - a.created_at.getTime() : a.created_at.getTime() - b.created_at.getTime()));
    return found[0] ?? null;
  });

  mocks.flag.updateMany.mockImplementation(async ({ where, data }: { where: { id: string; notified_at: Date | null }; data: { notified_at: Date } }) => {
    const f = store.flags.find((x) => x.id === where.id);
    if (!f || f.notified_at !== where.notified_at) return { count: 0 };
    f.notified_at = data.notified_at;
    return { count: 1 };
  });
});

describe('punchEmployee', () => {
  it('ALLOWS punching on an approved day-off (staff may come in to help)', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.overrides.push({
      id: 'o1',
      user_id: user.id,
      date: new Date('2026-07-10T00:00:00Z'),
      kind: 'DAY_OFF',
    });

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now: new Date('2026-07-10T08:00:00Z'),
    });
    expect('punch' in r).toBe(true);
    expect(store.punches.length).toBe(1);
  });

  it('rejects driver with open trip before reaching geofence', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch, 'DRIVER');
    store.users.set(user.id, user);
    store.trips.push({ id: 't1', driver_id: user.id, back_at: null });

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
    });
    expect('code' in r).toBe(true);
    if ('code' in r) expect(r.code).toBe('OPEN_TRIP_EXISTS');
    expect(store.punches.length).toBe(0);
  });

  it('rejects with LOW_GPS_ACCURACY when accuracy > max', async () => {
    const branch = makeBranch({ gps_accuracy_max_m: 100 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 200,
      deviceFp: 'fp',
      ip: '1.2.3.4',
    });
    expect('code' in r).toBe(true);
    if ('code' in r) expect(r.code).toBe('LOW_GPS_ACCURACY');
    expect(store.punches.length).toBe(0);
  });

  it('rejects with OUT_OF_GEOFENCE when outside radius', async () => {
    const branch = makeBranch({ gps_radius_m: 50 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.91,
      lng: 35.5,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
    });
    expect('code' in r).toBe(true);
    if ('code' in r) expect(r.code).toBe('OUT_OF_GEOFENCE');
    expect(store.punches.length).toBe(0);
  });

  it('rejects ALREADY_PUNCHED_IN when IN and session already open', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    const earlier = new Date(Date.now() - 60 * 60_000);
    store.punches.push({
      id: 'p1',
      user_id: user.id,
      branch_id: branch.id,
      kind: 'IN',
      at: earlier,
      lat: 33.8962,
      lng: 35.4827,
      accuracy_m: 10,
      device_fp: 'fp',
      ip: '1.2.3.4',
      corrected: false,
      corrected_by: null,
      correction_reason: null,
      created_at: earlier,
    });

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
    });
    expect('code' in r).toBe(true);
    if ('code' in r) expect(r.code).toBe('ALREADY_PUNCHED_IN');
  });

  it('happy path: IN inserts all 5 evidence fields + audit log', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);

    const result = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.89621,
      lng: 35.48271,
      accuracy: 12,
      deviceFp: 'fp-123',
      ip: '203.0.113.7',
    });

    expect('punch' in result).toBe(true);
    if ('punch' in result) {
      expect(result.punch.kind).toBe('IN');
      expect(result.punch.lat).toBe(33.89621);
      expect(result.punch.lng).toBe(35.48271);
      expect(result.punch.accuracy_m).toBe(12);
      expect(result.punch.device_fp).toBe('fp-123');
      expect(result.punch.ip).toBe('203.0.113.7');
      expect(result.minutes_since_in).toBe(0);
    }
    expect(store.audits.length).toBe(1);
    expect(store.punches.length).toBe(1);
  });

  it('happy path: OUT after IN yields minutes_since_in > 0', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    const earlier = new Date(Date.now() - 90 * 60_000);
    store.punches.push({
      id: 'p1',
      user_id: user.id,
      branch_id: branch.id,
      kind: 'IN',
      at: earlier,
      lat: 33.8962,
      lng: 35.4827,
      accuracy_m: 10,
      device_fp: 'fp',
      ip: '1.2.3.4',
      corrected: false,
      corrected_by: null,
      correction_reason: null,
      created_at: earlier,
    });

    const result = await punchEmployee({
      userId: 'u1',
      kind: 'OUT',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
    });

    expect('punch' in result).toBe(true);
    if ('punch' in result) {
      expect(result.punch.kind).toBe('OUT');
      expect(result.minutes_since_in).toBeGreaterThanOrEqual(89);
      expect(result.minutes_since_in).toBeLessThanOrEqual(91);
    }
  });

  it('day-off is ignored for punching; the open-trip guard still applies', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch, 'DRIVER');
    store.users.set(user.id, user);
    store.trips.push({ id: 't1', driver_id: user.id, back_at: null });
    store.overrides.push({
      id: 'o1',
      user_id: user.id,
      date: new Date('2026-07-10T00:00:00Z'),
      kind: 'DAY_OFF',
    });

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.91,
      lng: 35.5,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now: new Date('2026-07-10T08:00:00Z'),
    });
    // Day-off no longer blocks; a driver with an open trip is still blocked.
    expect('code' in r).toBe(true);
    if ('code' in r) expect(r.code).toBe('OPEN_TRIP_EXISTS');
  });
});

describe('WATCHED flag resolution (race-safe select-then-claim)', () => {
  it('resolves the oldest WATCHED flag and fires notifier when claim wins', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.flags.push({
      id: 'f1',
      user_id: user.id,
      kind: 'WATCHED',
      notified_at: null,
      context_json: { scheduled_start: '09:00' },
      created_at: new Date('2026-07-10T09:00:00Z'),
    });

    const sent: unknown[] = [];
    await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      notifier: { send: async (p) => { sent.push(p); } },
    });

    expect(sent.length).toBe(1);
    expect((sent[0] as { template: string }).template).toBe('watched_resolved');
    expect(store.flags[0]!.notified_at).not.toBeNull();
  });

  it('does not fire notifier when no WATCHED flag exists', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);

    const sent: unknown[] = [];
    await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      notifier: { send: async (p) => { sent.push(p); } },
    });
    expect(sent.length).toBe(0);
  });

  it('does not fire notifier when claim count is 0 (concurrent claim lost the race)', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.flags.push({
      id: 'f1',
      user_id: user.id,
      kind: 'WATCHED',
      notified_at: null,
      context_json: {},
      created_at: new Date(),
    });
    mocks.flag.updateMany.mockResolvedValue({ count: 0 });

    const sent: unknown[] = [];
    await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      notifier: { send: async (p) => { sent.push(p); } },
    });
    expect(sent.length).toBe(0);
  });

  it('selects oldest WATCHED flag first (orderBy created_at asc)', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.flags.push(
      { id: 'f-newer', user_id: user.id, kind: 'WATCHED', notified_at: null, context_json: {}, created_at: new Date('2026-07-10T10:00:00Z') },
      { id: 'f-older', user_id: user.id, kind: 'WATCHED', notified_at: null, context_json: {}, created_at: new Date('2026-07-10T09:00:00Z') },
    );

    const sent: Array<{ context: { watched: { id: string } } }> = [];
    await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      notifier: { send: async (p) => { sent.push(p as unknown as { context: { watched: { id: string } } }); } },
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.context.watched.id).toBe('f-older');
  });
});
