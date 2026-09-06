import { describe, it, expect, beforeEach } from 'vitest';
import { AUTO_CLOSE_AFTER_MIN as WEB_AUTO_CLOSE_AFTER_MIN } from '@/lib/services/autoClose';
import { MAX_OPEN_SESSION_MIN } from '@/lib/services/coverage';
import { systemCheckoutAt as webSystemCheckoutAt } from '@/lib/services/autoClose';
import { computePayoutFromRows } from '@/lib/services/payout';

type UserRow = { id: string; username: string; role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER'; branch?: { name: string } | null };
type PunchRow = {
  auto_close_revoked_at?: Date | null;
  id: string;
  user_id: string;
  branch_id: string;
  kind: 'IN' | 'OUT';
  at: Date;
  system_generated: boolean;
};
type ScheduleRow = { user_id: string; weekday: number; shift_min: number | null };
type OverrideRow = { user_id: string; date: Date; kind: 'DAY_OFF' | 'HOURS_CHANGE'; shift_min: number | null };
type AuditRow = { actor_id: string; action: string; entity: string; entity_id: string; after_json: unknown };

const store: {
  users: UserRow[];
  punches: PunchRow[];
  schedules: ScheduleRow[];
  overrides: OverrideRow[];
  audits: AuditRow[];
  flags: Array<{ kind: string; user_id: string; context_json: unknown }>;
  branches: Map<string, { lat: number; lng: number }>;
  seq: number;
} = { users: [], punches: [], schedules: [], overrides: [], audits: [], flags: [], branches: new Map(), seq: 0 };

import { runAutoCloseAbandoned, AUTO_CLOSE_AFTER_MIN, systemCheckoutAt } from './autoCloseAbandoned';

function resetStore() {
  store.users.length = 0;
  store.punches.length = 0;
  store.schedules.length = 0;
  store.overrides.length = 0;
  store.audits.length = 0;
  store.flags.length = 0;
  store.branches.clear();
  store.branches.set('b1', { lat: 33.8962, lng: 35.4827 });
  store.seq = 0;
}

function makeDb() {
  const db = {
    user: {
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        store.users
          .filter((u) => where.role.in.includes(u.role))
          .map((u) => ({ id: u.id, username: u.username, branch: u.branch ?? null })),
    },
    punch: {
      findFirst: async ({ where }: { where: { user_id: string; kind: 'IN' | 'OUT'; at?: { gt?: Date } } }) => {
        const rows = store.punches
          .filter((p) => p.user_id === where.user_id && p.kind === where.kind)
          .filter((p) => (where.at?.gt ? p.at > where.at.gt : true))
          .sort((a, b) => b.at.getTime() - a.at.getTime());
        const hit = rows[0];
        if (!hit) return null;
        return { ...hit, branch: store.branches.get(hit.branch_id) ?? null };
      },
      create: async ({ data }: { data: Omit<PunchRow, 'id'> }) => {
        store.seq += 1;
        const row: PunchRow = { ...(data as PunchRow), id: `auto${store.seq}` };
        store.punches.push(row);
        return row;
      },
    },
    schedule: {
      findUnique: async ({ where }: { where: { user_id_weekday: { user_id: string; weekday: number } } }) =>
        store.schedules.find(
          (s) => s.user_id === where.user_id_weekday.user_id && s.weekday === where.user_id_weekday.weekday,
        ) ?? null,
    },
    scheduleOverride: {
      findUnique: async ({ where }: { where: { user_id_date: { user_id: string; date: Date } } }) =>
        store.overrides.find(
          (o) =>
            o.user_id === where.user_id_date.user_id &&
            o.date.getTime() === where.user_id_date.date.getTime(),
        ) ?? null,
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
    flag: {
      create: async ({ data }: { data: { kind: string; user_id: string; context_json: unknown } }) => {
        store.flags.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

function seedEmployee(shiftMinByWeekday: Record<number, number> = {}) {
  store.users.push({ id: 'u1', username: 'bilal.f', role: 'EMPLOYEE', branch: { name: 'Mar lias' } });
  for (const [weekday, shift_min] of Object.entries(shiftMinByWeekday)) {
    store.schedules.push({ user_id: 'u1', weekday: Number(weekday), shift_min });
  }
}

function punchIn(at: Date) {
  store.seq += 1;
  store.punches.push({ id: `p${store.seq}`, user_id: 'u1', branch_id: 'b1', kind: 'IN', at, system_generated: false });
}

const RATE_CENT = 200;

function grossCentOfStore(): number {
  return computePayoutFromRows({
    userId: 'u1',
    punches: store.punches.map((p) => ({ id: p.id, user_id: p.user_id, kind: p.kind, at: p.at })),
    rateChanges: [{ user_id: 'u1', rate_cent: RATE_CENT, effective_from: new Date('2020-01-01T00:00:00Z') }],
    adjustments: [],
    approvedAdvances: [],
  }).grossCent;
}

beforeEach(resetStore);

// A Sunday (Beirut weekday 0) check-in at 09:00 local.
const CHECK_IN = new Date('2026-07-12T09:00:00+03:00');


describe('an arrival the owner has revoked', () => {
  it('is never closed again, however many times the sweep runs', async () => {
    // The sweep runs every ten minutes. Without this the row the owner just
    // deleted is written straight back, and the Revoke button is decorative.
    seedEmployee({ 1: 1020, 2: 1020 });
    punchIn(new Date('2026-09-07T07:00:00+03:00'));
    store.punches[0]!.auto_close_revoked_at = new Date('2026-09-08T03:00:00+03:00');

    for (const now of ['2026-09-08T04:00:00+03:00', '2026-09-08T13:10:00+03:00', '2026-09-09T09:00:00+03:00']) {
      const r = await runAutoCloseAbandoned({ db: makeDb() as never, now: new Date(now) });
      expect(r).toEqual({ closed: 0, notified: 0 });
    }
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
  });

  it('closes normally when it has NOT been revoked', async () => {
    // The same fixture without the mark, so the test above is proving the mark
    // and not some other reason the sweep skipped him.
    seedEmployee({ 1: 1020, 2: 1020 });
    punchIn(new Date('2026-09-07T07:00:00+03:00'));
    const r = await runAutoCloseAbandoned({
      db: makeDb() as never,
      now: new Date('2026-09-08T13:10:00+03:00'),
    });
    expect(r.closed).toBe(1);
  });
});
