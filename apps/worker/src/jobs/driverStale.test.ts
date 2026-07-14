import { describe, it, expect, beforeEach } from 'vitest';

type TripRow = {
  id: string;
  driver_id: string;
  branch_id: string;
  out_at: Date;
  back_at: Date | null;
};
type BranchRow = { id: string; name: string; trip_threshold_min: number };
type UserRow = { id: string; username: string };

const store: {
  trips: TripRow[];
  branches: Map<string, BranchRow>;
  users: Map<string, UserRow>;
  notifications: Array<{ template: string; context: unknown }>;
} = {
  trips: [],
  branches: new Map(),
  users: new Map(),
  notifications: [],
};

import { runDriverStale } from './driverStale';

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

describe('runDriverStale', () => {
  it('notifies when trip is open > 4h', async () => {
    store.users.set('d1', { id: 'd1', username: 'drv1' });
    const branch: BranchRow = { id: 'b1', name: 'Hamra', trip_threshold_min: 30 };
    store.branches.set(branch.id, branch);
    store.trips.push({
      id: 't1',
      driver_id: 'd1',
      branch_id: 'b1',
      out_at: new Date(Date.now() - 5 * 60 * 60_000),
      back_at: null,
    });

    const db = makeDb();
    const r = await runDriverStale({ db: db as never, notifier });
    expect(r.notified).toBe(1);
    expect(store.notifications[0]!.template).toBe('driver.stale');
  });

  it('does not notify if trip is < 4h', async () => {
    store.users.set('d1', { id: 'd1', username: 'drv1' });
    const branch: BranchRow = { id: 'b1', name: 'Hamra', trip_threshold_min: 30 };
    store.branches.set(branch.id, branch);
    store.trips.push({
      id: 't1',
      driver_id: 'd1',
      branch_id: 'b1',
      out_at: new Date(Date.now() - 2 * 60 * 60_000),
      back_at: null,
    });

    const db = makeDb();
    const r = await runDriverStale({ db: db as never, notifier });
    expect(r.notified).toBe(0);
  });
});