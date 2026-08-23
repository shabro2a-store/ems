import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_OPEN_SESSION_MIN as WEB_MAX_OPEN_SESSION_MIN } from '@/lib/services/coverage';
import { computePayoutFromRows } from '@/lib/services/payout';

type UserRow = { id: string; role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER' };
type PunchRow = {
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
  branches: Map<string, { lat: number; lng: number }>;
  seq: number;
} = { users: [], punches: [], schedules: [], overrides: [], audits: [], branches: new Map(), seq: 0 };

import { runAutoCloseAbandoned, MAX_OPEN_SESSION_MIN } from './autoCloseAbandoned';

function resetStore() {
  store.users.length = 0;
  store.punches.length = 0;
  store.schedules.length = 0;
  store.overrides.length = 0;
  store.audits.length = 0;
  store.branches.clear();
  store.branches.set('b1', { lat: 33.8962, lng: 35.4827 });
  store.seq = 0;
}

function makeDb() {
  const db = {
    user: {
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        store.users.filter((u) => where.role.in.includes(u.role)).map((u) => ({ id: u.id })),
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
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

function seedEmployee(shiftMinByWeekday: Record<number, number> = {}) {
  store.users.push({ id: 'u1', role: 'EMPLOYEE' });
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

describe('runAutoCloseAbandoned', () => {
  it('is the same abandoned threshold the web app already uses', () => {
    // Reusing one notion of "abandoned" is the point: if the dashboard stops
    // counting a session at 30h and this job closed it at some other figure,
    // there would be a window where the hours are invisible and the punch is
    // still open, or one where a live shift is closed under the employee.
    expect(MAX_OPEN_SESSION_MIN).toBe(WEB_MAX_OPEN_SESSION_MIN);
  });

  it('closes an abandoned check-in at check-in plus required, and pays exactly the shift', async () => {
    seedEmployee({ 0: 480 });
    punchIn(CHECK_IN);

    // Two full days later: the session has run away by 48h.
    const now = new Date('2026-07-14T09:00:00+03:00');
    const r = await runAutoCloseAbandoned({ db: makeDb() as never, now });

    expect(r.closed).toBe(1);
    const out = store.punches.find((p) => p.kind === 'OUT')!;
    expect(out.at.toISOString()).toBe(new Date('2026-07-12T17:00:00+03:00').toISOString());
    expect(out.system_generated).toBe(true);

    // 480 min at $2.00/h is $16.00. The runaway span is 2880 min - $96.00 -
    // and paying that is the failure this job exists to prevent.
    expect(grossCentOfStore()).toBe(1600);
    expect(grossCentOfStore()).not.toBe(Math.floor((2880 * RATE_CENT) / 60));
  });

  it('audits the write with the reasoning, as nobody made this punch', async () => {
    seedEmployee({ 0: 480 });
    punchIn(CHECK_IN);
    await runAutoCloseAbandoned({ db: makeDb() as never, now: new Date('2026-07-14T09:00:00+03:00') });

    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0]!;
    expect(audit.action).toBe('punch.auto_close');
    expect(audit.actor_id).toBe('system');
    const after = audit.after_json as { required_min: number; open_min: number; reason: string };
    expect(after.required_min).toBe(480);
    expect(after.open_min).toBe(48 * 60);
    expect(after.reason).toContain('abandoned-session threshold');
  });

  it('does not touch a genuine 14h overtime shift against a 12h requirement', async () => {
    seedEmployee({ 0: 720 });
    punchIn(CHECK_IN);

    // 14h in: two hours of real overtime, and well past the missedCheckout
    // trigger of required + grace (720 + 15 = 735 min). Closing here is exactly
    // the mistake the 30h threshold avoids - it would truncate the overrun into
    // the plain 12h shift and quietly take two hours' pay.
    const now = new Date('2026-07-12T23:00:00+03:00');
    const elapsedMin = (now.getTime() - CHECK_IN.getTime()) / 60_000;
    expect(elapsedMin).toBe(840);
    expect(elapsedMin).toBeGreaterThan(720 + 15);

    const r = await runAutoCloseAbandoned({ db: makeDb() as never, now });
    expect(r.closed).toBe(0);
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(0);
  });

  it('leaves a session that is open but not yet abandoned, to the minute', async () => {
    seedEmployee({ 0: 480 });
    punchIn(CHECK_IN);
    const db = makeDb();

    const atThreshold = new Date(CHECK_IN.getTime() + MAX_OPEN_SESSION_MIN * 60_000);
    expect((await runAutoCloseAbandoned({ db: db as never, now: atThreshold })).closed).toBe(0);

    const pastThreshold = new Date(atThreshold.getTime() + 60_000);
    expect((await runAutoCloseAbandoned({ db: db as never, now: pastThreshold })).closed).toBe(1);
  });

  it('honours a date override the same way payroll does', async () => {
    seedEmployee({ 0: 480 });
    store.overrides.push({
      user_id: 'u1',
      date: new Date('2026-07-12T00:00:00.000Z'),
      kind: 'HOURS_CHANGE',
      shift_min: 240,
    });
    punchIn(CHECK_IN);

    await runAutoCloseAbandoned({ db: makeDb() as never, now: new Date('2026-07-14T09:00:00+03:00') });
    const out = store.punches.find((p) => p.kind === 'OUT')!;
    expect(out.at.toISOString()).toBe(new Date('2026-07-12T13:00:00+03:00').toISOString());
  });

  it('closes a day that owed nothing at the check-in itself, rather than leaving it open', async () => {
    // Staff may clock in on a day off to help during a rush. Nothing was owed,
    // so nothing is paid - but the session still has to close, because an open
    // session is what blocks their next check-in.
    seedEmployee({ 0: 480 });
    store.overrides.push({
      user_id: 'u1',
      date: new Date('2026-07-12T00:00:00.000Z'),
      kind: 'DAY_OFF',
      shift_min: null,
    });
    punchIn(CHECK_IN);

    const r = await runAutoCloseAbandoned({ db: makeDb() as never, now: new Date('2026-07-14T09:00:00+03:00') });
    expect(r.closed).toBe(1);
    expect(store.punches.find((p) => p.kind === 'OUT')!.at.toISOString()).toBe(CHECK_IN.toISOString());
    expect(grossCentOfStore()).toBe(0);
  });

  it('writes one checkout and stops: a second run finds nothing to close', async () => {
    seedEmployee({ 0: 480 });
    punchIn(CHECK_IN);
    const db = makeDb();
    const now = new Date('2026-07-14T09:00:00+03:00');

    expect((await runAutoCloseAbandoned({ db: db as never, now })).closed).toBe(1);
    expect((await runAutoCloseAbandoned({ db: db as never, now })).closed).toBe(0);
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(1);
  });
});
