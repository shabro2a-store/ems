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
      shift_grace_min: number;
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
    shift_grace_min: number;
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
    system_generated: boolean;
    created_at: Date;
  }>;
  overrides: Array<{ id: string; user_id: string; date: Date; kind: 'DAY_OFF' | 'HOURS_CHANGE'; shift_min?: number | null }>;
  schedules: Array<{ user_id: string; weekday: number; shift_min: number }>;
  trips: Array<{
    id: string;
    driver_id: string;
    out_at: Date;
    back_at: Date | null;
    back_lat: number | null;
    back_lng: number | null;
    system_generated: boolean;
    branch: { lat: number; lng: number; trip_threshold_min: number };
  }>;
  audits: Array<{ id: string }>;
  flags: Array<{ id: string; user_id: string; kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; resolved_at: Date | null; context_json: unknown; created_at: Date }>;
  blocked: Array<{
    id: string;
    user_id: string;
    branch_id: string;
    at: Date;
    open_in_at: Date;
    lat: number;
    lng: number;
    accuracy_m: number;
    device_fp: string;
    ip: string;
  }>;
  auditActions: string[];
  punchSeq: number;
  auditSeq: number;
};

const store: Store = {
  users: new Map(),
  branches: new Map(),
  punches: [],
  overrides: [],
  schedules: [],
  trips: [],
  audits: [],
  flags: [],
  blocked: [],
  auditActions: [],
  punchSeq: 0,
  auditSeq: 0,
};

const mocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  scheduleOverride: { findUnique: vi.fn() },
  trip: { findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  punch: { findFirst: vi.fn(), create: vi.fn() },
  blockedPunchAttempt: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  flag: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  schedule: { findUnique: vi.fn() },
  $transaction: vi.fn(),
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
  store.schedules.length = 0;
  store.trips.length = 0;
  store.audits.length = 0;
  store.flags.length = 0;
  store.blocked.length = 0;
  store.auditActions.length = 0;
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
    shift_grace_min: 15,
    trip_threshold_min: 30,
    is_active: true,
    ...partial,
  };
}

function seedOpenIn(userId: string, branchId: string, at: Date) {
  store.punches.push({
    id: `seed-${store.punches.length + 1}`,
    user_id: userId,
    branch_id: branchId,
    kind: 'IN',
    at,
    lat: 33.8962,
    lng: 35.4827,
    accuracy_m: 10,
    device_fp: 'fp',
    ip: '1.2.3.4',
    corrected: false,
    corrected_by: null,
    correction_reason: null,
    system_generated: false,
    created_at: at,
  });
}

function seedOpenTrip(userId: string, branch: ReturnType<typeof makeBranch>, outAt: Date) {
  store.trips.push({
    id: `t${store.trips.length + 1}`,
    driver_id: userId,
    out_at: outAt,
    back_at: null,
    back_lat: null,
    back_lng: null,
    system_generated: false,
    branch: { lat: branch.lat, lng: branch.lng, trip_threshold_min: branch.trip_threshold_min },
  });
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

  // The self-resolve path asks what the arrival's day owed, then closes the
  // session inside a transaction. Default: nothing scheduled, so requiredMin is
  // 0 and only the elapsed/day-boundary conditions decide staleness.
  mocks.schedule.findUnique.mockImplementation(async ({ where }: { where: { user_id_weekday: { user_id: string; weekday: number } } }) => {
    return store.schedules.find((s) => s.user_id === where.user_id_weekday.user_id && s.weekday === where.user_id_weekday.weekday) ?? null;
  });

  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks));

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

  mocks.trip.updateMany.mockImplementation(async ({ where, data }: { where: { id: string; back_at: null }; data: { back_at: Date; back_lat: number; back_lng: number; system_generated: boolean } }) => {
    const t = store.trips.find((x) => x.id === where.id);
    if (!t || t.back_at !== where.back_at) return { count: 0 };
    t.back_at = data.back_at;
    t.back_lat = data.back_lat;
    t.back_lng = data.back_lng;
    t.system_generated = data.system_generated;
    return { count: 1 };
  });

  mocks.trip.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    return store.trips.find((t) => t.id === where.id) ?? null;
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
      // Prisma's column default. A punch the employee made carries no
      // system_generated in its payload, so without this the assertions that
      // distinguish their punch from the system's would compare undefined.
      system_generated: false,
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

  mocks.flag.create.mockImplementation(async ({ data }: { data: { kind: Store['flags'][number]['kind']; user_id: string; context_json: unknown } }) => {
    const f = {
      id: `f${store.flags.length + 1}`,
      user_id: data.user_id,
      kind: data.kind,
      resolved_at: null,
      context_json: data.context_json,
      created_at: new Date(),
    };
    store.flags.push(f);
    return f;
  });

  mocks.blockedPunchAttempt.create.mockImplementation(async ({ data }: { data: Store['blocked'][number] }) => {
    const row = { ...data, id: `bp${store.blocked.length + 1}` };
    store.blocked.push(row);
    return row;
  });

  mocks.auditLog.create.mockImplementation(async ({ data }: { data: { action: string } }) => {
    store.auditSeq += 1;
    const a = { id: `a${store.auditSeq}` };
    store.audits.push(a);
    store.auditActions.push(data.action);
    return a;
  });

  mocks.flag.findFirst.mockImplementation(async ({ where }: { where: { kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD'; user_id: string; resolved_at: Date | null; orderBy?: { created_at: 'asc' | 'desc' } } }) => {
    const found = store.flags
      .filter((f) => f.kind === where.kind && f.user_id === where.user_id && f.resolved_at === where.resolved_at)
      .sort((a, b) => (where.orderBy?.created_at === 'desc' ? b.created_at.getTime() - a.created_at.getTime() : a.created_at.getTime() - b.created_at.getTime()));
    return found[0] ?? null;
  });

  mocks.flag.updateMany.mockImplementation(async ({ where, data }: { where: { id: string; resolved_at: Date | null }; data: { resolved_at: Date } }) => {
    const f = store.flags.find((x) => x.id === where.id);
    if (!f || f.resolved_at !== where.resolved_at) return { count: 0 };
    f.resolved_at = data.resolved_at;
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
    seedOpenTrip(user.id, branch, new Date('2026-07-10T07:30:00Z'));

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
    // Same Beirut day as `now`, so this is a duplicate tap rather than a shift
    // that is over: it must be refused, not silently closed.
    const earlier = new Date('2026-07-12T03:00:00Z');
    seedOpenIn(user.id, branch.id, earlier);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now: new Date('2026-07-12T06:00:00Z'),
    });
    expect('code' in r).toBe(true);
    if ('code' in r) {
      expect(r.code).toBe('ALREADY_PUNCHED_IN');
      // The caller needs the shift in the way to tell the employee what to fix.
      expect(r.openInAt?.toISOString()).toBe(earlier.toISOString());
    }
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
    // Pinned rather than relative to Date.now(): a real clock puts the arrival
    // on the previous Beirut day whenever the suite runs between midnight and
    // 01:30 local, which is now the self-resolve path and not this one.
    const earlier = new Date('2026-07-12T04:30:00Z');
    const now = new Date('2026-07-12T06:00:00Z');
    seedOpenIn(user.id, branch.id, earlier);

    const result = await punchEmployee({
      userId: 'u1',
      kind: 'OUT',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now,
    });

    expect('punch' in result).toBe(true);
    if ('punch' in result) {
      expect(result.punch.kind).toBe('OUT');
      expect(result.minutes_since_in).toBe(90);
      expect(result.systemClosedInsteadOfPunch).toBeUndefined();
    }
  });

  it('day-off is ignored for punching; the open-trip guard still applies', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch, 'DRIVER');
    store.users.set(user.id, user);
    seedOpenTrip(user.id, branch, new Date('2026-07-10T07:30:00Z'));
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

// A blocked attempt is paid time (see blockedCredit.ts), so what may be
// recorded is a money question, not a logging one. The only thing standing
// between "I was at work and could not clock in" and an unverified claim from
// a sofa is that punch.ts checks the geofence BEFORE it checks the session
// state - so a rejection carrying ALREADY_PUNCHED_IN has already proved the
// person is at the branch.
describe('recording the blocked check-in', () => {
  // Deliberately the SAME Beirut day as NOW. A session from a day that is over
  // no longer refuses anything - punchEmployee closes it and lets the check-in
  // through - so the only refusals left to record are duplicates like this one.
  const OPEN_SINCE = new Date('2026-07-12T03:00:00Z'); // 06:00 Beirut
  const NOW = new Date('2026-07-12T06:00:00Z'); // 09:00 Beirut, same day

  it('records the refusal with the GPS that placed them at the branch', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    seedOpenIn(user.id, branch.id, OPEN_SINCE);

    await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.89622,
      lng: 35.48272,
      accuracy: 11,
      deviceFp: 'fp-blocked',
      ip: '203.0.113.9',
      now: NOW,
    });

    expect(store.blocked).toHaveLength(1);
    const row = store.blocked[0]!;
    expect(row.user_id).toBe('u1');
    expect(row.branch_id).toBe('b1');
    expect(row.at.toISOString()).toBe(NOW.toISOString());
    expect(row.open_in_at.toISOString()).toBe(OPEN_SINCE.toISOString());
    expect(row.lat).toBe(33.89622);
    expect(row.lng).toBe(35.48272);
    expect(row.accuracy_m).toBe(11);
    expect(store.auditActions).toContain('punch.blocked');
  });

  it('records nothing when the same blocked employee tries from outside the geofence', async () => {
    // The fixture has an open session, so the ONLY thing stopping a row being
    // written is the geofence check running first. Without that ordering this
    // attempt - made from far outside the radius - would be recorded as paid
    // time at the branch.
    const branch = makeBranch({ gps_radius_m: 50 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    seedOpenIn(user.id, branch.id, OPEN_SINCE);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.91,
      lng: 35.5,
      accuracy: 10,
      deviceFp: 'fp-home',
      ip: '203.0.113.9',
      now: NOW,
    });

    expect(store.blocked).toHaveLength(0);
    expect(store.auditActions).not.toContain('punch.blocked');
    expect('code' in r && r.code).toBe('OUT_OF_GEOFENCE');
  });

  it('records nothing when GPS is too weak to place them at the branch', async () => {
    const branch = makeBranch({ gps_accuracy_max_m: 100 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    seedOpenIn(user.id, branch.id, OPEN_SINCE);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 400,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now: NOW,
    });

    expect(store.blocked).toHaveLength(0);
    expect('code' in r && r.code).toBe('LOW_GPS_ACCURACY');
  });

  it('records nothing for a driver stopped by the open-trip guard', async () => {
    // That guard runs before the geofence, so this rejection proves nothing
    // about where the driver is.
    const branch = makeBranch();
    const user = makeUser('u1', branch, 'DRIVER');
    store.users.set(user.id, user);
    seedOpenTrip(user.id, branch, new Date(NOW.getTime() - 30 * 60_000));
    seedOpenIn(user.id, branch.id, OPEN_SINCE);

    const r = await punchEmployee({
      userId: 'u1',
      kind: 'IN',
      lat: 33.8962,
      lng: 35.4827,
      accuracy: 10,
      deviceFp: 'fp',
      ip: '1.2.3.4',
      now: NOW,
    });

    expect('code' in r && r.code).toBe('OPEN_TRIP_EXISTS');
    expect(store.blocked).toHaveLength(0);
  });

  it('records nothing on a check-in that succeeds, or on a clock-out', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);

    await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4', now: NOW,
    });
    await punchEmployee({
      userId: 'u1', kind: 'OUT', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date(NOW.getTime() + 3_600_000),
    });

    expect(store.blocked).toHaveLength(0);
  });
});

/**
 * The block used to be a wall: the employee's screen offered CLOCK OUT on the
 * stale session, they tapped it, and payroll paid the whole runaway span - so
 * the block was rarely even seen, and a night worker refused at 21:00 with no
 * check-in that Beirut day lost the night entirely.
 *
 * Somebody standing at the branch past the geofence asking to start a shift has
 * demonstrably finished the old one. That is better evidence than the 30h sweep
 * ever has, so the same close happens here.
 */
describe('self-resolving a session left open from a shift-day that is over', () => {
  // 21:00 Beirut Saturday, an 8h night shift nobody closed.
  const NIGHT_BEFORE = new Date('2026-07-11T18:00:00Z');
  const NEXT_EVENING = new Date('2026-07-12T18:00:00Z'); // 21:00 Beirut Sunday

  function seedNightWorker() {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    // Saturday is Beirut weekday 6; the arrival is a Saturday.
    store.schedules.push({ user_id: 'u1', weekday: 6, shift_min: 480 });
    seedOpenIn(user.id, branch.id, NIGHT_BEFORE);
    return { branch, user };
  }

  it('closes the stale shift at its scheduled hours and lets the check-in through', async () => {
    seedNightWorker();

    const r = await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: NEXT_EVENING,
    });

    expect('punch' in r).toBe(true);
    if (!('punch' in r)) return;
    expect(r.punch.kind).toBe('IN');
    expect(r.punch.at.toISOString()).toBe(NEXT_EVENING.toISOString());
    // 21:00 + 8h = 05:00 Beirut Sunday, not 24h of runaway span.
    expect(r.systemClosedAt?.toISOString()).toBe(new Date('2026-07-12T02:00:00Z').toISOString());

    const out = store.punches.find((p) => p.kind === 'OUT')!;
    expect(out.at.toISOString()).toBe(new Date('2026-07-12T02:00:00Z').toISOString());
    expect((out as unknown as { system_generated: boolean }).system_generated).toBe(true);
    expect(store.auditActions).toContain('punch.auto_close');
    // Nothing was refused, so nothing is recorded as a refusal.
    expect(store.blocked).toHaveLength(0);
  });

  it('closes it on a clock-out only once the session is past 30h', async () => {
    seedNightWorker();
    // 31 hours after the arrival: past MAX_OPEN_SESSION_MIN, so not a shift.
    const r = await punchEmployee({
      userId: 'u1', kind: 'OUT', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date(NIGHT_BEFORE.getTime() + 31 * 3_600_000),
    });

    expect('punch' in r).toBe(true);
    if (!('punch' in r)) return;
    expect(r.systemClosedInsteadOfPunch).toBe(true);
    // No punch of theirs: writing one at `now` pays the 31h span, and
    // backdating theirs would make the record lie about when they pressed it.
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(1);
    expect(r.minutes_since_in).toBe(480);
  });

  it('refuses a duplicate tap on the same Beirut day rather than closing a shift in progress', async () => {
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.schedules.push({ user_id: 'u1', weekday: 0, shift_min: 480 });
    const startedThisMorning = new Date('2026-07-12T03:00:00Z'); // 06:00 Beirut Sunday
    seedOpenIn(user.id, branch.id, startedThisMorning);

    const r = await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date('2026-07-12T13:00:00Z'), // 16:00 Beirut, 10h in - past 480 + 15
    });

    expect('code' in r && r.code).toBe('ALREADY_PUNCHED_IN');
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
    expect(store.auditActions).not.toContain('punch.auto_close');
  });

  it('refuses a stray tap mid-way through an overnight shift', async () => {
    // 21:00 Saturday, 10h scheduled. At 02:00 Sunday they are five hours in and
    // still working. The calendar day has turned over, so the day-boundary
    // condition alone would happily close the shift under them.
    const branch = makeBranch();
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.schedules.push({ user_id: 'u1', weekday: 6, shift_min: 600 });
    seedOpenIn(user.id, branch.id, NIGHT_BEFORE);

    const r = await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date('2026-07-11T23:00:00Z'), // 02:00 Beirut Sunday, 5h elapsed
    });

    expect('code' in r && r.code).toBe('ALREADY_PUNCHED_IN');
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
  });

  it('refuses a stray tap in the grace window past an overnight shift, rather than truncating it', async () => {
    // The case that pins the elapsed condition specifically. 21:00 Saturday,
    // 10h scheduled, tapped at 07:10 Sunday: ten minutes over, inside the
    // branch's 15 min grace. The close would land at 07:00 - BEFORE now - so
    // the "close must precede now" guard does not catch this one, and the
    // day-boundary condition is long since satisfied. Only "past required +
    // grace" stops it, and without it the employee's shift is silently
    // truncated to exactly ten hours and their overrun taken.
    const branch = makeBranch({ shift_grace_min: 15 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    store.schedules.push({ user_id: 'u1', weekday: 6, shift_min: 600 });
    seedOpenIn(user.id, branch.id, NIGHT_BEFORE);

    const r = await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date('2026-07-12T04:10:00Z'), // 07:10 Beirut Sunday, 610 min elapsed
    });

    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
    expect(store.auditActions).not.toContain('punch.auto_close');
    expect('code' in r && r.code).toBe('ALREADY_PUNCHED_IN');
  });

  it('never writes a close that lands at or after now, which no guard could see', async () => {
    // A 0-required session opened at 23:59:30 Beirut. One minute later the
    // calendar day has turned and the elapsed time is past 0 + 0 grace, but the
    // close would land on `now` itself - the exact shape that locked people out.
    const branch = makeBranch({ shift_grace_min: 0 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    seedOpenIn(user.id, branch.id, new Date('2026-07-11T20:59:30Z'));

    const r = await punchEmployee({
      userId: 'u1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date('2026-07-11T21:00:15Z'),
    });

    expect('code' in r && r.code).toBe('ALREADY_PUNCHED_IN');
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
  });
});

/**
 * The system may close a session out from under a check-in, because the
 * check-in is itself evidence the old shift ended. It must NOT do that to a
 * clock-out: the employee is standing there asserting the truth about their own
 * shift. Overruling them at `required + grace` - the moment overtime begins -
 * paid them the scheduled hours and wrote a record saying they left earlier
 * than they did.
 */
describe('a clock-out the employee makes is never overruled below 30h', () => {
  function seedWorker(weekday: number, shiftMin: number, arrivalAt: Date) {
    const branch = makeBranch({ shift_grace_min: 15 });
    const user = makeUser('u1', branch);
    store.users.set(user.id, user);
    if (shiftMin > 0) store.schedules.push({ user_id: 'u1', weekday, shift_min: shiftMin });
    seedOpenIn(user.id, branch.id, arrivalAt);
  }

  async function clockOut(now: Date) {
    return punchEmployee({
      userId: 'u1', kind: 'OUT', lat: 33.8962, lng: 35.4827, accuracy: 10, deviceFp: 'fp', ip: '1.2.3.4', now,
    });
  }

  it('night shift 21:00 clocking out 07:16 against 10h is paid 616 minutes, not 600', async () => {
    // Saturday 21:00 Beirut, 10h scheduled. 07:16 Sunday is 616 minutes: past
    // required + grace (615) by one minute, and 16 minutes of real overtime.
    const arrival = new Date('2026-07-11T18:00:00Z');
    seedWorker(6, 600, arrival);
    const now = new Date('2026-07-12T04:16:00Z');

    const r = await clockOut(now);
    expect('punch' in r).toBe(true);
    if (!('punch' in r)) return;
    expect(r.minutes_since_in).toBe(616);
    expect(r.systemClosedInsteadOfPunch).toBeUndefined();
    const outs = store.punches.filter((p) => p.kind === 'OUT');
    expect(outs).toHaveLength(1);
    // Their own punch, at the instant they made it - not a backdated 07:00.
    expect(outs[0]!.at.toISOString()).toBe(now.toISOString());
    expect(outs[0]!.system_generated).toBe(false);
  });

  it('a late day shift 16:00 clocking out 00:40 against 8h is paid 520 minutes, not 480', async () => {
    // Crosses midnight, so the arrival is an earlier Beirut calendar day and
    // 520 > 480 + 15. Both check-in conditions are met; the clock-out must
    // still take the employee at their word.
    const arrival = new Date('2026-07-11T13:00:00Z'); // 16:00 Beirut Saturday
    seedWorker(6, 480, arrival);
    const now = new Date('2026-07-11T21:40:00Z'); // 00:40 Beirut Sunday

    const r = await clockOut(now);
    expect('punch' in r).toBe(true);
    if (!('punch' in r)) return;
    expect(r.minutes_since_in).toBe(520);
    expect(r.systemClosedInsteadOfPunch).toBeUndefined();
    expect(store.punches.find((p) => p.kind === 'OUT')!.at.toISOString()).toBe(now.toISOString());
  });

  it('a day-off helper 21:00 to 02:00 is paid 300 minutes, not one', async () => {
    // Nothing scheduled, so requiredMin is 0 and required + grace is 15. Under
    // the check-in threshold this paid three cents for a five-hour evening.
    const arrival = new Date('2026-07-11T18:00:00Z');
    seedWorker(6, 0, arrival);
    const now = new Date('2026-07-11T23:00:00Z'); // 02:00 Beirut Sunday

    const r = await clockOut(now);
    expect('punch' in r).toBe(true);
    if (!('punch' in r)) return;
    expect(r.minutes_since_in).toBe(300);
    expect(r.systemClosedInsteadOfPunch).toBeUndefined();
    expect(store.punches.find((p) => p.kind === 'OUT')!.at.toISOString()).toBe(now.toISOString());
  });

  it('holds right up to the 30h boundary, and gives way one minute past it', async () => {
    const arrival = new Date('2026-07-11T18:00:00Z');
    seedWorker(6, 600, arrival);

    const atBoundary = await clockOut(new Date(arrival.getTime() + 30 * 3_600_000));
    expect('punch' in atBoundary && atBoundary.systemClosedInsteadOfPunch).toBeUndefined();
    expect(store.punches.find((p) => p.kind === 'OUT')!.system_generated).toBe(false);

    store.punches.length = 0;
    seedOpenIn('u1', 'b1', arrival);
    const past = await clockOut(new Date(arrival.getTime() + 30 * 3_600_000 + 60_000));
    expect('punch' in past && past.systemClosedInsteadOfPunch).toBe(true);
    expect(store.punches.find((p) => p.kind === 'OUT')!.system_generated).toBe(true);
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
      resolved_at: null,
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
    expect(store.flags[0]!.resolved_at).not.toBeNull();
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
      resolved_at: null,
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
      { id: 'f-newer', user_id: user.id, kind: 'WATCHED', resolved_at: null, context_json: {}, created_at: new Date('2026-07-10T10:00:00Z') },
      { id: 'f-older', user_id: user.id, kind: 'WATCHED', resolved_at: null, context_json: {}, created_at: new Date('2026-07-10T09:00:00Z') },
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

// An open trip is the only gate on a driver's punch with no natural end: the
// driver has to remember to press BACK, and nothing else in the system could
// write one. A press that never came locked them out of clocking in AND out,
// escapable only by pressing BACK hours later - recording a return that never
// happened - and not escapable at all once the trip's branch was deactivated,
// because verifyWithinGeofence drops inactive branches and reports TOO_FAR.
describe('a trip nobody ended stops blocking the driver', () => {
  const OUT_AT = new Date('2026-07-10T18:00:00Z');

  function driverWithOpenTrip(outAt: Date, branchOverrides: Record<string, unknown> = {}) {
    const branch = makeBranch(branchOverrides);
    const user = makeUser('d1', branch, 'DRIVER');
    store.users.set(user.id, user);
    seedOpenTrip(user.id, branch, outAt);
    return { branch, user };
  }

  it('still refuses a delivery that is plausibly running', async () => {
    driverWithOpenTrip(OUT_AT);

    const r = await punchEmployee({
      userId: 'd1', kind: 'OUT', lat: 33.8962, lng: 35.4827, accuracy: 10,
      deviceFp: 'fp', ip: '1.2.3.4',
      // Five hours out is long, and driverStale has already alerted at four -
      // but it is under the abandoned threshold, so the driver is still out.
      now: new Date(OUT_AT.getTime() + 5 * 60 * 60_000),
    });

    expect('code' in r && r.code).toBe('OPEN_TRIP_EXISTS');
    expect(store.trips[0]!.back_at).toBeNull();
  });

  it('closes an abandoned trip and lets the check-in through', async () => {
    driverWithOpenTrip(OUT_AT);
    const now = new Date(OUT_AT.getTime() + 14 * 60 * 60_000); // next morning

    const r = await punchEmployee({
      userId: 'd1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10,
      deviceFp: 'fp', ip: '1.2.3.4', now,
    });

    expect('punch' in r).toBe(true);
    if ('punch' in r) {
      expect(r.punch.kind).toBe('IN');
      // Their own check-in, at the real time. Nothing of theirs is discarded.
      expect(r.punch.at).toEqual(now);
      expect(r.punch.system_generated).toBe(false);
      // Closed at out + the branch's delivery time, NOT at now: a BACK nobody
      // pressed cannot date a return, so the system credits the delivery the
      // branch defines and not the fourteen hours the trip sat open.
      expect(r.systemClosedTripAt).toEqual(new Date(OUT_AT.getTime() + 30 * 60_000));
    }
    expect(store.trips[0]!.back_at).toEqual(new Date(OUT_AT.getTime() + 30 * 60_000));
    expect(store.trips[0]!.system_generated).toBe(true);
    expect(store.auditActions).toContain('trip.auto_close');
  });

  it('closes an abandoned trip and lets the clock-out through', async () => {
    const { branch, user } = driverWithOpenTrip(OUT_AT);
    // Went out at 18:00 on a shift that started at 14:00, never pressed BACK,
    // and is trying to end the shift the same evening.
    seedOpenIn(user.id, branch.id, new Date('2026-07-10T14:00:00Z'));
    const now = new Date(OUT_AT.getTime() + 7 * 60 * 60_000);

    const r = await punchEmployee({
      userId: 'd1', kind: 'OUT', lat: 33.8962, lng: 35.4827, accuracy: 10,
      deviceFp: 'fp', ip: '1.2.3.4', now,
    });

    expect('punch' in r).toBe(true);
    if ('punch' in r) {
      expect(r.punch.kind).toBe('OUT');
      // Under MAX_OPEN_SESSION_MIN, so the clock-out they made stands - the
      // trip close must not drag the session close in with it.
      expect(r.punch.at).toEqual(now);
      expect(r.systemClosedInsteadOfPunch).toBeUndefined();
      expect(r.systemClosedTripAt).toEqual(new Date(OUT_AT.getTime() + 30 * 60_000));
    }
    expect(store.trips[0]!.back_at).toEqual(new Date(OUT_AT.getTime() + 30 * 60_000));
  });

  it('uses the dispatching branch threshold, not a driver moved since', async () => {
    // The order was taken at a branch allowing 90 minutes; the driver has since
    // been reassigned to one allowing 30. The delivery is credited under the
    // rules it was actually dispatched under.
    const dispatchedFrom = makeBranch({ id: 'b-old', trip_threshold_min: 90 });
    const nowBranch = makeBranch({ id: 'b-new', trip_threshold_min: 30 });
    const user = makeUser('d1', nowBranch, 'DRIVER');
    store.users.set(user.id, user);
    seedOpenTrip(user.id, dispatchedFrom, OUT_AT);

    const r = await punchEmployee({
      userId: 'd1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10,
      deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date(OUT_AT.getTime() + 14 * 60 * 60_000),
    });

    expect('punch' in r).toBe(true);
    expect(store.trips[0]!.back_at).toEqual(new Date(OUT_AT.getTime() + 90 * 60_000));
  });

  it('closes the trip even when the punch is then refused for something else', async () => {
    // A duplicate check-in on the same day is still ALREADY_PUNCHED_IN - but
    // the trip is over either way, and leaving it open would keep the driver
    // undispatchable and would block the clock-out that actually fixes this.
    const { branch, user } = driverWithOpenTrip(OUT_AT);
    seedOpenIn(user.id, branch.id, new Date(OUT_AT.getTime() + 13 * 60 * 60_000));

    const r = await punchEmployee({
      userId: 'd1', kind: 'IN', lat: 33.8962, lng: 35.4827, accuracy: 10,
      deviceFp: 'fp', ip: '1.2.3.4',
      now: new Date(OUT_AT.getTime() + 14 * 60 * 60_000),
    });

    expect('code' in r && r.code).toBe('ALREADY_PUNCHED_IN');
    expect(store.trips[0]!.back_at).toEqual(new Date(OUT_AT.getTime() + 30 * 60_000));
  });
});
