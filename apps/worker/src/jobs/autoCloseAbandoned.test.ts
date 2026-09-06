import { describe, it, expect, beforeEach } from 'vitest';
import { AUTO_CLOSE_AFTER_MIN as WEB_AUTO_CLOSE_AFTER_MIN } from '@/lib/services/autoClose';
import { MAX_OPEN_SESSION_MIN } from '@/lib/services/coverage';
import { systemCheckoutAt as webSystemCheckoutAt } from '@/lib/services/autoClose';
import { computePayoutFromRows } from '@/lib/services/payout';

type UserRow = { id: string; username: string; role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER'; branch?: { name: string } | null };
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

describe('runAutoCloseAbandoned', () => {
  it('is the same abandoned threshold the web app already uses', () => {
    // Reusing one notion of "abandoned" is the point: the sweep and the
    // clock-out path both refuse a session past it, and if they disagreed there
    // would be a window where this job has closed a shift the clock-out would
    // still have accepted - or the reverse, where the employee is handed the
    // scheduled hours by a rule the sweep does not think has fired yet.
    expect(AUTO_CLOSE_AFTER_MIN).toBe(WEB_AUTO_CLOSE_AFTER_MIN);
    expect(AUTO_CLOSE_AFTER_MIN).toBe(20 * 60);
  });

  it('is a different question from MAX_OPEN_SESSION_MIN, and lower', () => {
    // Two thresholds that are easy to conflate. MAX_OPEN_SESSION_MIN asks "may
    // this session still be counted in today's hours" and has to sit above a
    // full 24h shift_min so no real shift is clamped. This one asks "should we
    // stop waiting for a checkout", which is a judgement, and 20h is deliberately
    // low enough to reach a real double cover - the notification and the Revoke
    // button are what make that the recoverable error rather than a silent one.
    expect(AUTO_CLOSE_AFTER_MIN).toBeLessThan(MAX_OPEN_SESSION_MIN);
    expect(MAX_OPEN_SESSION_MIN).toBe(30 * 60);
  });

  it('writes the checkout at the same instant the web rule says, including the one-minute floor', () => {
    // The blocked-check-in path in punch.ts closes a stale session with the web
    // copy of this rule. Two closes of the same shape landing on different
    // instants would mean the same forgotten shift paid differently depending
    // on which one got there first.
    const arrival = new Date('2026-07-12T09:00:00+03:00');
    for (const requiredMin of [0, 1, 15, 240, 480, 720, 1440]) {
      expect(systemCheckoutAt(arrival, requiredMin).toISOString()).toBe(
        webSystemCheckoutAt(arrival, requiredMin).toISOString(),
      );
    }
    // Zero required must not land on the arrival itself - every "is this
    // session still open" guard asks for an OUT strictly after the IN.
    expect(systemCheckoutAt(arrival, 0).getTime()).toBeGreaterThan(arrival.getTime());
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
    // the mistake the threshold avoids - it would truncate the overrun into
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

    const atThreshold = new Date(CHECK_IN.getTime() + AUTO_CLOSE_AFTER_MIN * 60_000);
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

  it('closes a day that owed nothing, and closing it actually ends the session', async () => {
    // Staff may clock in on a day off to help during a rush. Nothing was owed,
    // so essentially nothing is paid - but the session still has to close,
    // because an open session is what blocks their next check-in.
    //
    // This runs TWICE on purpose. The first version of this job wrote the
    // checkout at exactly the arrival on a 0-required day, and every guard in
    // the codebase asks for an OUT strictly AFTER the arrival - so the session
    // stayed open, this job wrote another checkout every ten minutes forever,
    // and punch.ts refused the employee's next check-in for good. Nothing
    // alerted: missedCheckout skips days requiring nothing. The single-run
    // version of this test passed throughout.
    seedEmployee({ 0: 480 });
    store.overrides.push({
      user_id: 'u1',
      date: new Date('2026-07-12T00:00:00.000Z'),
      kind: 'DAY_OFF',
      shift_min: null,
    });
    punchIn(CHECK_IN);

    const db = makeDb();
    const now = new Date('2026-07-14T09:00:00+03:00');
    expect((await runAutoCloseAbandoned({ db: db as never, now })).closed).toBe(1);

    const out = store.punches.find((p) => p.kind === 'OUT')!;
    expect(out.at.getTime()).toBeGreaterThan(CHECK_IN.getTime());
    expect(out.at.toISOString()).toBe(new Date(CHECK_IN.getTime() + 60_000).toISOString());
    // A minute at $2.00/h floors to 3 cents. The ruling says zero; three cents
    // is what a record visible to the guards costs.
    expect(grossCentOfStore()).toBe(3);

    // Nothing else watches a 0-required day - missedCheckout and
    // watchedDetector both skip them, and deltaMin >= 0 raises no penalty - so
    // without this flag the owner is never told an evening paid three cents.
    expect(store.flags).toHaveLength(1);
    expect(store.flags[0]!.kind).toBe('MISSED_CHECKOUT');
    expect(store.flags[0]!.context_json).toMatchObject({ shift_min: 0, zero_required_auto_close: true });

    // The session is now genuinely closed: nothing more to do, ever.
    expect((await runAutoCloseAbandoned({ db: db as never, now })).closed).toBe(0);
    expect(
      (await runAutoCloseAbandoned({ db: db as never, now: new Date('2026-07-20T09:00:00+03:00') })).closed,
    ).toBe(0);
    expect(store.punches.filter((p) => p.kind === 'OUT')).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it('leaves a 0-required session closed so the employee can clock in again', async () => {
    // The lockout was the real damage: with the session still open, punch.ts
    // answers ALREADY_PUNCHED_IN to every future check-in.
    seedEmployee({ 0: 480 });
    store.overrides.push({
      user_id: 'u1',
      date: new Date('2026-07-12T00:00:00.000Z'),
      kind: 'DAY_OFF',
      shift_min: null,
    });
    punchIn(CHECK_IN);
    const db = makeDb();
    await runAutoCloseAbandoned({ db: db as never, now: new Date('2026-07-14T09:00:00+03:00') });

    // The exact query every open-session guard runs.
    const laterOut = await db.punch.findFirst({
      where: { user_id: 'u1', kind: 'OUT', at: { gt: CHECK_IN } },
    });
    expect(laterOut).not.toBeNull();
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

describe('telling the owner a checkout was written for somebody', () => {
  function collector() {
    const sent: Array<{ template: string; context: Record<string, unknown> }> = [];
    return {
      sent,
      notifier: {
        send: async (p: { template: string; context: unknown }) => {
          sent.push({ template: p.template, context: p.context as Record<string, unknown> });
        },
      },
    };
  }

  it('names the shift, the hours paid, and that overtime is not in them', async () => {
    // A 17h employee who clocked in Friday 07:00 and never punched out. The job
    // runs 31h later, past the threshold.
    seedEmployee({ 0: 1020, 1: 1020, 2: 1020, 3: 1020, 4: 1020, 5: 1020, 6: 1020 });
    punchIn(new Date('2026-09-04T07:00:00+03:00'));
    const { sent, notifier } = collector();

    const r = await runAutoCloseAbandoned({
      db: makeDb() as never,
      now: new Date('2026-09-05T14:00:00+03:00'),
      notifier: notifier as never,
    });

    expect(r).toEqual({ closed: 1, notified: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('punch.auto_close');
    const msg = String(sent[0]!.context.message);
    expect(msg).toContain('bilal.f');
    expect(msg).toContain('Mar lias');
    expect(msg).toContain('2026-09-04 07:00'); // the arrival nobody closed
    expect(msg).toContain('2026-09-05 00:00'); // 07:00 + 17h, in Beirut
    expect(msg).toContain('17h');
    expect(msg).toContain('overtime actually worked is NOT included');
    expect(sent[0]!.context.required_min).toBe(1020);
  });

  it('says nothing when there was nothing to close', async () => {
    seedEmployee({ 5: 1020 });
    punchIn(new Date('2026-09-04T07:00:00+03:00'));
    const { sent, notifier } = collector();
    // 16h open - inside the threshold. This is a long shift, not an abandoned
    // one, and the owner must not be told his hours were decided.
    const r = await runAutoCloseAbandoned({
      db: makeDb() as never,
      now: new Date('2026-09-05T03:00:00+03:00'),
      notifier: notifier as never,
    });
    expect(r).toEqual({ closed: 0, notified: 0 });
    expect(sent).toEqual([]);
  });

  it('still writes the checkout when the notification throws', async () => {
    // The punch is what unblocks tomorrow's check-in. Telegram being down is
    // not a reason to leave the employee locked out.
    seedEmployee({ 5: 480 });
    punchIn(new Date('2026-09-04T07:00:00+03:00'));
    const r = await runAutoCloseAbandoned({
      db: makeDb() as never,
      now: new Date('2026-09-05T14:00:00+03:00'),
      notifier: { send: async () => { throw new Error('telegram down'); } } as never,
    });
    expect(r).toEqual({ closed: 1, notified: 0 });
    expect(store.punches.filter((p) => p.kind === 'OUT' && p.system_generated)).toHaveLength(1);
  });

  it('closes normally with no notifier at all', async () => {
    seedEmployee({ 5: 480 });
    punchIn(new Date('2026-09-04T07:00:00+03:00'));
    const r = await runAutoCloseAbandoned({ db: makeDb() as never, now: new Date('2026-09-05T14:00:00+03:00') });
    expect(r).toEqual({ closed: 1, notified: 0 });
  });
});
