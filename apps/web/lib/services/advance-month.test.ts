import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { scheduledToUtc } from 'time';
import { payoutForUser } from './payout';
import { requestAdvance, decideAdvance } from './advances';
import { advancePayMonth } from './advanceMonth';

/*
 * #20 - the cap: pending requests were not counted against it, and approving
 * never checked it, so three $200 requests on $250 earned all went through.
 * #21 - the month: an advance counted in the month it was REQUESTED, so one
 * approved after that month's pay was settled was never taken back at all.
 */

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
    }
    const c = cond as { gte?: Date; gt?: Date; lt?: Date; lte?: Date; in?: unknown[] };
    if (c.in) return c.in.includes(value);
    if (value === null || value === undefined) return false;
    const v = (value as Date).getTime();
    return (
      (c.gte === undefined || v >= c.gte.getTime()) &&
      (c.gt === undefined || v > c.gt.getTime()) &&
      (c.lt === undefined || v < c.lt.getTime()) &&
      (c.lte === undefined || v <= c.lte.getTime())
    );
  });
}

function fakeDb(tables: Record<string, Row[]>): PrismaClient {
  const model = (name: string) => {
    const rows = (tables[name] ??= []);
    return {
      findMany: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)),
      findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
      findFirst: async ({ where }: { where?: Where } = {}) => rows.find((r) => matches(r, where)) ?? null,
      aggregate: async ({ where }: { where?: Where }) => ({
        _sum: { amount_cent: rows.filter((r) => matches(r, where)).reduce((s, r) => s + (r.amount_cent as number), 0) || null },
      }),
      count: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `${name}${rows.length + 1}`, created_at: new Date(), ...data } as Row;
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    };
  };
  return new Proxy({}, { get: (_t, k: string) => model(k) }) as unknown as PrismaClient;
}

const USER = 'u1';
const rate = { id: 'r1', user_id: USER, rate_cent: 1000, effective_from: new Date('2026-01-01T00:00:00Z') };
const user = { id: USER, username: 'emp', name: null, role: 'EMPLOYEE', day_start_hour: null, branch: { shift_grace_min: 15 } };
const shift = (day: string, from: string, to: string, n: number): Row[] => [
  { id: `in${n}`, user_id: USER, kind: 'IN', at: scheduledToUtc(day, from) },
  { id: `out${n}`, user_id: USER, kind: 'OUT', at: scheduledToUtc(day, to) },
];
const advance = (id: string, cents: number, status: string, created: Date, decided: Date | null = null): Row => ({
  id, user_id: USER, amount_cent: cents, status, reason: null, created_at: created, decided_at: decided, decided_by: decided ? 'admin' : null,
});
const quiet = { send: async () => undefined };

describe('the month an advance comes out of', () => {
  it('is the month it was asked for, while that month is still open', () => {
    // Asked on the evening of 30 November, approved the next morning: November
    // is open for a day after it ends, so November's pay carries it.
    expect(advancePayMonth({ created_at: scheduledToUtc('2026-11-30', '21:00'), decided_at: scheduledToUtc('2026-12-01', '10:00') })).toBe('2026-11');
  });

  it('is the next open month once the asked-for month was settled', () => {
    expect(advancePayMonth({ created_at: scheduledToUtc('2026-11-30', '21:00'), decided_at: scheduledToUtc('2026-12-03', '10:00') })).toBe('2026-12');
  });

  it('leaves decisions made before the change where they were paid', () => {
    expect(advancePayMonth({ created_at: scheduledToUtc('2026-08-30', '21:00'), decided_at: scheduledToUtc('2026-09-05', '10:00') })).toBe('2026-08');
  });

  it('falls back to the asked-for month when there is no decision time', () => {
    expect(advancePayMonth({ created_at: scheduledToUtc('2026-11-30', '21:00'), decided_at: null })).toBe('2026-11');
  });
});

describe('payroll deducts a late-approved advance from the month it came out of', () => {
  it('takes it from December, not from the November pay that went out without it', async () => {
    const db = fakeDb({
      punch: [...shift('2026-11-10', '08:00', '16:00', 1), ...shift('2026-12-02', '08:00', '16:00', 2)],
      rateChange: [rate],
      user: [user],
      advance: [advance('a1', 5000, 'APPROVED', scheduledToUtc('2026-11-30', '21:00'), scheduledToUtc('2026-12-03', '10:00'))],
    });
    expect((await payoutForUser(USER, '2026-11', db)).advancesCent).toBe(0);
    expect((await payoutForUser(USER, '2026-12', db)).advancesCent).toBe(5000);
  });
});

describe('the advance cap', () => {
  // 8h at $10 on 2 December: $80 earned.
  const tables = () => ({
    punch: shift('2026-12-02', '08:00', '16:00', 1),
    rateChange: [rate],
    user: [user],
    advance: [] as Row[],
  });
  const now = scheduledToUtc('2026-12-05', '12:00');

  it('counts requests still waiting for an answer', async () => {
    const t = tables();
    t.advance.push(advance('p1', 6000, 'PENDING', scheduledToUtc('2026-12-04', '09:00')));
    const r = await requestAdvance({ userId: USER, amountCent: 3000, month: '2026-12', db: fakeDb(t), notifier: quiet });
    expect(r).toEqual({ ok: false, code: 'EXCEEDS_ACCRUED_EARNINGS' });
  });

  it('is checked again when the owner approves', async () => {
    const t = tables();
    t.advance.push(
      advance('p1', 6000, 'PENDING', scheduledToUtc('2026-12-04', '09:00')),
      advance('p2', 6000, 'PENDING', scheduledToUtc('2026-12-04', '09:05')),
    );
    const db = fakeDb(t);
    expect(await decideAdvance({ adminId: 'admin', advanceId: 'p1', decision: 'APPROVED', db, now })).toMatchObject({ ok: true });
    expect(await decideAdvance({ adminId: 'admin', advanceId: 'p2', decision: 'APPROVED', db, now })).toMatchObject({
      ok: false,
      code: 'EXCEEDS_ACCRUED_EARNINGS',
      earnedCent: 8000,
      advancedCent: 6000,
    });
    expect(t.advance.find((a) => a.id === 'p2')!.status).toBe('PENDING');
  });

  it('never stops the owner saying no', async () => {
    const t = tables();
    t.advance.push(advance('p1', 999999, 'PENDING', scheduledToUtc('2026-12-04', '09:00')));
    expect(await decideAdvance({ adminId: 'admin', advanceId: 'p1', decision: 'REJECTED', db: fakeDb(t), now })).toMatchObject({ ok: true });
  });

  it('approves each request once, even when two clicks race', async () => {
    const t = tables();
    t.advance.push(advance('p1', 1000, 'PENDING', scheduledToUtc('2026-12-04', '09:00')));
    const db = fakeDb(t);
    const [a, b] = await Promise.all([
      decideAdvance({ adminId: 'admin', advanceId: 'p1', decision: 'APPROVED', db, now }),
      decideAdvance({ adminId: 'admin', advanceId: 'p1', decision: 'APPROVED', db, now }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((t as Record<string, Row[]>).auditLog.filter((r) => r.action === 'advance.approve')).toHaveLength(1);
  });
});
