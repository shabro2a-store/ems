import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_OPEN_TRIP_MIN as WEB_MAX_OPEN_TRIP_MIN,
  systemBackAt as webSystemBackAt,
} from '@/lib/services/tripClose';
import {
  runAutoCloseAbandonedTrips,
  MAX_OPEN_TRIP_MIN,
  systemBackAt,
} from './autoCloseAbandonedTrips';

type TripRow = {
  id: string;
  driver_id: string;
  out_at: Date;
  back_at: Date | null;
  back_lat: number | null;
  back_lng: number | null;
  system_generated: boolean;
  branch: { lat: number; lng: number; trip_threshold_min: number };
};
type AuditRow = { actor_id: string; action: string; entity: string; entity_id: string; after_json: unknown };

const store: { trips: TripRow[]; audits: AuditRow[] } = { trips: [], audits: [] };

function resetStore() {
  store.trips.length = 0;
  store.audits.length = 0;
}

function makeDb() {
  const db = {
    trip: {
      findMany: async ({ where }: { where: { back_at: null; out_at: { lt: Date } } }) =>
        store.trips.filter((t) => t.back_at === null && t.out_at < where.out_at.lt),
      updateMany: async ({ where, data }: { where: { id: string; back_at: null }; data: Partial<TripRow> }) => {
        const t = store.trips.find((x) => x.id === where.id);
        if (!t || t.back_at !== where.back_at) return { count: 0 };
        Object.assign(t, data);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

function seedTrip(partial: Partial<TripRow> & { out_at: Date }) {
  store.trips.push({
    id: `t${store.trips.length + 1}`,
    driver_id: 'd1',
    back_at: null,
    back_lat: null,
    back_lng: null,
    system_generated: false,
    branch: { lat: 33.8962, lng: 35.4827, trip_threshold_min: 30 },
    ...partial,
  });
}

beforeEach(resetStore);

const OUT = new Date('2026-07-10T18:00:00Z');
const at = (min: number) => new Date(OUT.getTime() + min * 60_000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (now: Date) => runAutoCloseAbandonedTrips({ db: makeDb() as any, now });

describe('runAutoCloseAbandonedTrips', () => {
  it('is the same abandoned threshold the web app already uses', () => {
    // The driver's punch path closes an abandoned trip the moment they try to
    // clock. If this job used a different figure, a trip could be abandoned to
    // one and live to the other, and which of them ran first would decide
    // whether the driver was locked out.
    expect(MAX_OPEN_TRIP_MIN).toBe(WEB_MAX_OPEN_TRIP_MIN);
    for (const threshold of [1, 30, 90, 240]) {
      expect(systemBackAt(OUT, threshold)).toEqual(webSystemBackAt(OUT, threshold));
    }
    expect(systemBackAt(OUT, 0)).toEqual(webSystemBackAt(OUT, 0));
  });

  it('leaves a delivery that could still be running alone', async () => {
    seedTrip({ out_at: OUT });
    expect(await run(at(MAX_OPEN_TRIP_MIN))).toEqual({ closed: 0 });
    expect(store.trips[0]!.back_at).toBeNull();
    expect(store.audits).toHaveLength(0);
  });

  it('closes an abandoned trip at out + the branch delivery time', async () => {
    seedTrip({ out_at: OUT });
    expect(await run(at(3 * 24 * 60))).toEqual({ closed: 1 });

    const t = store.trips[0]!;
    // Three days open, closed at thirty minutes: the driver never pressed BACK,
    // so nothing can say when they got back and the branch's own figure stands.
    expect(t.back_at).toEqual(at(30));
    expect(t.system_generated).toBe(true);
    // The branch's coordinates, because nobody stood anywhere to make this.
    expect(t.back_lat).toBe(33.8962);
    expect(t.back_lng).toBe(35.4827);

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]!.actor_id).toBe('system');
    expect(store.audits[0]!.action).toBe('trip.auto_close');
    expect(store.audits[0]!.entity_id).toBe(t.id);
  });

  it('uses each trip own branch threshold', async () => {
    seedTrip({ out_at: OUT, branch: { lat: 1, lng: 2, trip_threshold_min: 90 } });
    seedTrip({ out_at: OUT, driver_id: 'd2' });
    await run(at(12 * 60));
    expect(store.trips[0]!.back_at).toEqual(at(90));
    expect(store.trips[1]!.back_at).toEqual(at(30));
  });

  it('never touches a trip the driver closed themselves', async () => {
    const real = at(200);
    seedTrip({ out_at: OUT, back_at: real, back_lat: 33.9, back_lng: 35.5 });
    expect(await run(at(12 * 60))).toEqual({ closed: 0 });
    expect(store.trips[0]!.back_at).toEqual(real);
    expect(store.trips[0]!.system_generated).toBe(false);
  });

  it('is idempotent across overlapping runs', async () => {
    seedTrip({ out_at: OUT });
    expect(await run(at(12 * 60))).toEqual({ closed: 1 });
    expect(await run(at(12 * 60 + 10))).toEqual({ closed: 0 });
    expect(store.audits).toHaveLength(1);
  });
});
