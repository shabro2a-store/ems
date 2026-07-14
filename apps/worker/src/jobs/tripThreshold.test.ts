import { describe, it, expect, beforeEach } from 'vitest';

type TripRow = {
  id: string;
  driver_id: string;
  branch_id: string;
  out_at: Date;
  back_at: Date | null;
  over_threshold: boolean;
  threshold_alerted_at: Date | null;
};
type BranchRow = { id: string; name: string; trip_threshold_min: number };
type UserRow = { id: string; username: string };

const store: {
  trips: TripRow[];
  branches: Map<string, BranchRow>;
  users: Map<string, UserRow>;
  notifications: Array<{ channel: string; recipient: string; template: string; context: unknown }>;
} = {
  trips: [],
  branches: new Map(),
  users: new Map(),
  notifications: [],
};

import { runTripThreshold } from './tripThreshold';

function resetStore() {
  store.trips.length = 0;
  store.branches.clear();
  store.users.clear();
  store.notifications.length = 0;
}

function makeDb() {
  return {
    trip: {
      findMany: async ({ where }: { where: { back_at: null } }) => {
        return store.trips
          .filter((t) => t.back_at === null)
          .map((t) => ({
            ...t,
            driver: store.users.get(t.driver_id),
            branch: store.branches.get(t.branch_id),
          }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ threshold_alerted_at: Date; over_threshold: boolean }> }) => {
        const t = store.trips.find((x) => x.id === where.id);
        if (!t) throw new Error('not found');
        Object.assign(t, data);
        return t;
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

describe('runTripThreshold', () => {
  it('sends notification once per open trip past threshold', async () => {
    store.users.set('d1', { id: 'd1', username: 'drv1' });
    const branch: BranchRow = { id: 'b1', name: 'Hamra', trip_threshold_min: 30 };
    store.branches.set(branch.id, branch);
    store.trips.push({
      id: 't1',
      driver_id: 'd1',
      branch_id: 'b1',
      out_at: new Date(Date.now() - 40 * 60_000),
      back_at: null,
      over_threshold: false,
      threshold_alerted_at: null,
    });

    const db = makeDb();
    const r = await runTripThreshold({ db: db as never, notifier });
    expect(r.notified).toBe(1);
    expect(store.trips[0]!.threshold_alerted_at).not.toBeNull();
  });

  it('does not notify if already alerted', async () => {
    store.users.set('d1', { id: 'd1', username: 'drv1' });
    const branch: BranchRow = { id: 'b1', name: 'Hamra', trip_threshold_min: 30 };
    store.branches.set(branch.id, branch);
    store.trips.push({
      id: 't1',
      driver_id: 'd1',
      branch_id: 'b1',
      out_at: new Date(Date.now() - 40 * 60_000),
      back_at: null,
      over_threshold: true,
      threshold_alerted_at: new Date(),
    });

    const db = makeDb();
    const r = await runTripThreshold({ db: db as never, notifier });
    expect(r.notified).toBe(0);
  });

  it('does not notify if trip is below threshold', async () => {
    store.users.set('d1', { id: 'd1', username: 'drv1' });
    const branch: BranchRow = { id: 'b1', name: 'Hamra', trip_threshold_min: 30 };
    store.branches.set(branch.id, branch);
    store.trips.push({
      id: 't1',
      driver_id: 'd1',
      branch_id: 'b1',
      out_at: new Date(Date.now() - 10 * 60_000),
      back_at: null,
      over_threshold: false,
      threshold_alerted_at: null,
    });

    const db = makeDb();
    const r = await runTripThreshold({ db: db as never, notifier });
    expect(r.notified).toBe(0);
  });
});