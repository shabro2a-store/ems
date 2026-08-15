import { describe, it, expect, vi, beforeEach } from 'vitest';

type TripRow = {
  id: string;
  driver_id: string;
  branch_id: string;
  out_at: Date;
  out_lat: number;
  out_lng: number;
  back_at: Date | null;
  back_lat: number | null;
  back_lng: number | null;
  threshold_alerted_at: Date | null;
};

const store: {
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
      is_active: boolean;
    } | null;
  }>;
  branches: Map<string, {
    id: string;
    lat: number;
    lng: number;
    gps_radius_m: number;
    gps_accuracy_max_m: number;
    is_active: boolean;
    trip_threshold_min: number;
  }>;
  trips: TripRow[];
  overrides: Array<{ user_id: string; date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE' }>;
  calls: Array<{ id: string; driver_id: string; trip_id: string | null; created_at: Date }>;
  tripSeq: number;
} = {
  users: new Map(),
  branches: new Map(),
  trips: [],
  overrides: [],
  calls: [],
  tripSeq: 0,
};

const mocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  scheduleOverride: { findUnique: vi.fn() },
  trip: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  driverCall: { findFirst: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({
  prisma: mocks as unknown as Record<string, unknown>,
}));

import { startTrip, endTrip, currentTrip } from './trip';

function resetStore() {
  store.users.clear();
  store.branches.clear();
  store.trips.length = 0;
  store.overrides.length = 0;
  store.calls.length = 0;
  store.tripSeq = 0;
}

function makeBranch(over: Partial<{ id: string; gps_radius_m: number; gps_accuracy_max_m: number; trip_threshold_min: number }> = {}) {
  return {
    id: over.id ?? 'b1',
    name: 'Hamra',
    lat: 33.8962,
    lng: 35.4827,
    gps_radius_m: over.gps_radius_m ?? 200,
    gps_accuracy_max_m: over.gps_accuracy_max_m ?? 100,
    overtime_grace_min: 15,
    trip_threshold_min: over.trip_threshold_min ?? 30,
    is_active: true,
  };
}

function makeDriver(id: string, branch: ReturnType<typeof makeBranch>) {
  const u = {
    id,
    username: id,
    is_active: true,
    role: 'DRIVER' as const,
    branch_id: branch.id,
    branch,
    hourly_rate_cent: 200,
    password_hash: 'x',
    telegram_chat_id: null as string | null,
    notify_daily_summary: true,
    notify_routine_pings: true,
    created_at: new Date(),
  };
  store.users.set(id, u);
  // Every driver is dispatched by default (the caller rang them) so existing
  // start-trip tests reflect the normal flow. Tests can clear store.calls to
  // simulate an undispatched driver.
  store.calls.push({ id: `call-${id}`, driver_id: id, trip_id: null, created_at: new Date() });
  return u;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  const b = makeBranch();
  store.branches.set(b.id, b);

  mocks.user.findUnique.mockImplementation(async ({ where, include }: { where: { id: string }; include?: { branch: true } }) => {
    const u = store.users.get(where.id);
    if (!u) return null;
    if (include?.branch) return u;
    const { branch: _b, ...rest } = u;
    return rest;
  });

  mocks.scheduleOverride.findUnique.mockImplementation(async ({ where }: { where: { user_id_date: { user_id: string; date: Date } } }) => {
    return store.overrides.find((o) => o.user_id === where.user_id_date.user_id && o.date.getTime() === where.user_id_date.date.getTime()) ?? null;
  });

  mocks.trip.findFirst.mockImplementation(async ({ where }: { where: { driver_id: string; back_at: null | { not?: null } } }) => {
    return store.trips.find((t) => {
      if (t.driver_id !== where.driver_id) return false;
      if (where.back_at === null) return t.back_at === null;
      return true;
    }) ?? null;
  });

  mocks.trip.create.mockImplementation(async ({ data }: { data: { driver_id: string; branch_id: string; out_at: Date; out_lat: number; out_lng: number } }) => {
    store.tripSeq += 1;
    const t = {
      id: `t${store.tripSeq}`,
      driver_id: data.driver_id,
      branch_id: data.branch_id,
      out_at: data.out_at,
      out_lat: data.out_lat,
      out_lng: data.out_lng,
      back_at: null,
      back_lat: null,
      back_lng: null,
      threshold_alerted_at: null,
    };
    store.trips.push(t);
    return t;
  });

  mocks.trip.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<{ back_at: Date; back_lat: number; back_lng: number }> }) => {
    const t = store.trips.find((x) => x.id === where.id);
    if (!t) throw new Error('not found');
    Object.assign(t, data);
    return t;
  });

  mocks.driverCall.findFirst.mockImplementation(async ({ where }: { where: { driver_id: string; trip_id: null; created_at?: { gte: Date } } }) => {
    const cutoff = where.created_at?.gte;
    return (
      store.calls
        .filter((c) => c.driver_id === where.driver_id && c.trip_id === null && (!cutoff || c.created_at >= cutoff))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null
    );
  });

  mocks.driverCall.updateMany.mockImplementation(async ({ where, data }: { where: { id: string; trip_id: null }; data: { trip_id: string } }) => {
    let count = 0;
    for (const c of store.calls) {
      if (c.id === where.id && c.trip_id === null) { c.trip_id = data.trip_id; count += 1; }
    }
    return { count };
  });

  // Run transaction callbacks against the same mock client.
  mocks.$transaction.mockImplementation(async (fn: (tx: typeof mocks) => unknown) => fn(mocks));
});

describe('startTrip', () => {
  it('starts a trip inside geofence', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    store.branches.set(b.id, b);
    const driver = makeDriver('d1', b);
    const r = await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('trip_id' in r).toBe(true);
    if ('trip_id' in r) {
      expect(r.trip_id).toBe('t1');
      expect(store.trips.length).toBe(1);
    }
  });

  it('rejects an undispatched driver with NOT_DISPATCHED (caller must ring first)', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    store.branches.set(b.id, b);
    const driver = makeDriver('d1', b);
    store.calls.length = 0; // no ring from the caller
    const r = await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('code' in r && r.code).toBe('NOT_DISPATCHED');
    expect(store.trips.length).toBe(0);
  });

  it('consumes the dispatch call so it cannot start a second trip', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    store.branches.set(b.id, b);
    const driver = makeDriver('d1', b);
    const r1 = await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('trip_id' in r1).toBe(true);
    expect(store.calls[0]!.trip_id).toBe('t1'); // call linked to the trip
  });

  it('rejects non-driver with NOT_DRIVER', async () => {
    const b = makeBranch();
    const u = {
      id: 'e1', username: 'e1', is_active: true, role: 'EMPLOYEE' as const,
      branch_id: b.id, branch: b, hourly_rate_cent: 200, password_hash: 'x',
      telegram_chat_id: null, notify_daily_summary: true, notify_routine_pings: true, created_at: new Date(),
    };
    store.users.set(u.id, u);
    const r = await startTrip({ userId: 'e1', lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('code' in r && r.code).toBe('NOT_DRIVER');
  });

  it('rejects 2nd open trip with OPEN_TRIP_EXISTS', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    const driver = makeDriver('d1', b);
    await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    const r = await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('code' in r && r.code).toBe('OPEN_TRIP_EXISTS');
  });

  it('rejects outside geofence with OUT_OF_GEOFENCE', async () => {
    const b = makeBranch({ gps_radius_m: 50 });
    const driver = makeDriver('d1', b);
    const r = await startTrip({ userId: driver.id, lat: 33.91, lng: 35.5, accuracy: 10 });
    expect('code' in r && r.code).toBe('OUT_OF_GEOFENCE');
  });
});

describe('endTrip', () => {
  it('ends an open trip', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    const driver = makeDriver('d1', b);
    await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    const outAt = store.trips[0]!.out_at;
    const r = await endTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10, now: new Date(outAt.getTime() + 30 * 60_000) });
    expect('trip_id' in r && r.trip_id).toBe('t1');
    if ('duration_min' in r) expect(r.duration_min).toBe(30);
    expect(store.trips[0]!.back_at).not.toBeNull();
  });

  it('rejects when no open trip with NO_OPEN_TRIP', async () => {
    const b = makeBranch();
    const driver = makeDriver('d1', b);
    const r = await endTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('code' in r && r.code).toBe('NO_OPEN_TRIP');
  });

  it('rejects end outside geofence with OUT_OF_GEOFENCE', async () => {
    const b = makeBranch({ gps_radius_m: 50 });
    const driver = makeDriver('d1', b);
    await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    const r = await endTrip({ userId: driver.id, lat: 33.91, lng: 35.5, accuracy: 10 });
    expect('code' in r && r.code).toBe('OUT_OF_GEOFENCE');
  });

  it('rejects non-driver', async () => {
    const b = makeBranch();
    const u = {
      id: 'e1', username: 'e1', is_active: true, role: 'EMPLOYEE' as const,
      branch_id: b.id, branch: b, hourly_rate_cent: 200, password_hash: 'x',
      telegram_chat_id: null, notify_daily_summary: true, notify_routine_pings: true, created_at: new Date(),
    };
    store.users.set(u.id, u);
    const r = await endTrip({ userId: 'e1', lat: 33.8962, lng: 35.4827, accuracy: 10 });
    expect('code' in r && r.code).toBe('NOT_DRIVER');
  });
});

describe('currentTrip', () => {
  it('returns open: false with threshold when no trip', async () => {
    const b = makeBranch({ trip_threshold_min: 45 });
    const driver = makeDriver('d1', b);
    const r = await currentTrip(driver.id);
    expect(r.open).toBe(false);
    expect(r.threshold_min).toBe(45);
  });

  it('returns open: true with since_min when trip is open', async () => {
    const b = makeBranch({ gps_radius_m: 200 });
    const driver = makeDriver('d1', b);
    const earlier = new Date(Date.now() - 15 * 60_000);
    mocks.trip.create.mockImplementationOnce(async ({ data }: { data: { driver_id: string; branch_id: string; out_at: Date; out_lat: number; out_lng: number } }) => {
      store.tripSeq += 1;
      const t = { id: `t${store.tripSeq}`, driver_id: data.driver_id, branch_id: data.branch_id, out_at: earlier, out_lat: data.out_lat, out_lng: data.out_lng, back_at: null, back_lat: null, back_lng: null, threshold_alerted_at: null };
      store.trips.push(t);
      return t;
    });
    await startTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 });
    const r = await currentTrip(driver.id);
    expect(r.open).toBe(true);
    expect(r.since_min).toBeGreaterThanOrEqual(14);
  });
});