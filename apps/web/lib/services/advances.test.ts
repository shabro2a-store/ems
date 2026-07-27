import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  advances: [] as Array<{
    id: string;
    user_id: string;
    amount_cent: number;
    reason: string | null;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    decided_by: string | null;
    decided_at: Date | null;
    created_at: Date;
  }>,
  adjustments: [] as Array<{ user_id: string; kind: 'BONUS' | 'DEDUCTION'; amount_cent: number; period: Date }>,
  audits: [] as Array<{ id: string; action: string; entity: string; entity_id: string }>,
  auditSeq: 0,
  advanceSeq: 0,
  punches: [] as Array<{ id: string; user_id: string; kind: 'IN' | 'OUT'; at: Date }>,
  rateChanges: [] as Array<{ user_id: string; rate_cent: number; effective_from: Date }>,
};

const mocks = vi.hoisted(() => ({
  advance: {
    aggregate: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  punch: { findMany: vi.fn() },
  rateChange: { findMany: vi.fn() },
  adjustment: { findMany: vi.fn() },
  schedule: { findMany: vi.fn() },
  scheduleOverride: { findMany: vi.fn() },
  penaltyWaiver: { findMany: vi.fn() },
}));

vi.mock('@/lib/db/prisma', () => ({
  prisma: mocks as unknown as Record<string, unknown>,
}));

import { requestAdvance, decideAdvance, advancesSummary } from './advances';

function resetStore() {
  store.advances.length = 0;
  store.audits.length = 0;
  store.auditSeq = 0;
  store.advanceSeq = 0;
  store.punches.length = 0;
  store.rateChanges.length = 0;
  store.adjustments.length = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();

  mocks.advance.aggregate.mockImplementation(async ({ where }: { where: { user_id: string; status?: string; created_at?: { gte: Date; lt: Date } } }) => {
    const sum = store.advances
      .filter((a) => a.user_id === where.user_id && (!where.status || a.status === where.status))
      .filter((a) => !where.created_at || (a.created_at >= where.created_at.gte && a.created_at < where.created_at.lt))
      .reduce((s, a) => s + a.amount_cent, 0);
    return { _sum: { amount_cent: sum || null } };
  });

  mocks.adjustment.findMany.mockImplementation(async ({ where }: { where: { user_id: string; period?: { gte: Date; lt: Date } } }) => {
    return store.adjustments
      .filter((a) => a.user_id === where.user_id && (!where.period || (a.period >= where.period.gte && a.period < where.period.lt)))
      .map((a) => ({ kind: a.kind, amount_cent: a.amount_cent }));
  });

  mocks.advance.count.mockImplementation(async ({ where }: { where: { user_id: string; status?: string } }) => {
    return store.advances.filter((a) => a.user_id === where.user_id && (!where.status || a.status === where.status)).length;
  });

  mocks.advance.create.mockImplementation(async ({ data }: { data: { user_id: string; amount_cent: number; reason?: string | null; status: 'PENDING' } }) => {
    store.advanceSeq += 1;
    const a = {
      id: `adv${store.advanceSeq}`,
      user_id: data.user_id,
      amount_cent: data.amount_cent,
      reason: data.reason ?? null,
      status: data.status,
      decided_by: null,
      decided_at: null,
      created_at: new Date('2026-07-15T00:00:00Z'),
    };
    store.advances.push(a);
    return a;
  });

  mocks.advance.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    return store.advances.find((a) => a.id === where.id) ?? null;
  });

  mocks.advance.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<{ status: 'APPROVED' | 'REJECTED'; decided_by: string; decided_at: Date }> }) => {
    const a = store.advances.find((x) => x.id === where.id);
    if (!a) throw new Error('not found');
    Object.assign(a, data);
    return a;
  });

  mocks.auditLog.create.mockImplementation(async ({ data }: { data: { actor_id: string; action: string; entity: string; entity_id: string; before_json?: unknown; after_json?: unknown } }) => {
    store.auditSeq += 1;
    const r = { id: `a${store.auditSeq}`, action: data.action, entity: data.entity, entity_id: data.entity_id };
    store.audits.push(r);
    return r;
  });

  mocks.punch.findMany.mockImplementation(async () => store.punches);
  mocks.rateChange.findMany.mockImplementation(async () => store.rateChanges);
  mocks.schedule.findMany.mockImplementation(async () => []);
  mocks.scheduleOverride.findMany.mockImplementation(async () => []);
  mocks.penaltyWaiver.findMany.mockImplementation(async () => []);
});

describe('requestAdvance', () => {
  it('approves a small advance and writes an audit row', async () => {
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-01T08:00:00Z') },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-01T18:00:00Z') },
    );
    store.rateChanges.push({ user_id: 'u1', rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });

    const r = await requestAdvance({ userId: 'u1', amountCent: 5000, month: '2026-07' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('PENDING');

    const audit = store.audits.find((a) => a.action === 'advance.create' && a.entity === 'Advance');
    expect(audit).toBeTruthy();
  });

  it('rejects when approved_balance + new_amount > accrued_earnings', async () => {
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-01T08:00:00Z') },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-01T16:00:00Z') },
    );
    store.rateChanges.push({ user_id: 'u1', rate_cent: 200, effective_from: new Date('2026-01-01T00:00:00Z') });
    store.advances.push({
      id: 'adv0',
      user_id: 'u1',
      amount_cent: 1500,
      reason: null,
      status: 'APPROVED',
      decided_by: 'admin',
      decided_at: new Date(),
      created_at: new Date('2026-07-05T00:00:00Z'),
    });

    const r = await requestAdvance({ userId: 'u1', amountCent: 999999, month: '2026-07' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXCEEDS_ACCRUED_EARNINGS');
  });

  it('allows an advance covered by a bonus even when worked hours are small', async () => {
    // Only ~$3 of worked wages this month...
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-01T08:00:00Z') },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-01T09:00:00Z') },
    );
    store.rateChanges.push({ user_id: 'u1', rate_cent: 300, effective_from: new Date('2026-01-01T00:00:00Z') });
    // ...but a $50 bonus was granted.
    store.adjustments.push({ user_id: 'u1', kind: 'BONUS', amount_cent: 5000, period: new Date('2026-07-01T00:00:00Z') });

    const r = await requestAdvance({ userId: 'u1', amountCent: 2000, month: '2026-07' });
    expect(r.ok).toBe(true);
  });

  it('a deduction lowers what can be borrowed', async () => {
    store.punches.push(
      { id: 'p1', user_id: 'u1', kind: 'IN', at: new Date('2026-07-01T08:00:00Z') },
      { id: 'p2', user_id: 'u1', kind: 'OUT', at: new Date('2026-07-01T18:00:00Z') },
    );
    store.rateChanges.push({ user_id: 'u1', rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') });
    // 10h * $6 = $60 gross, minus a $55 deduction => $5 available.
    store.adjustments.push({ user_id: 'u1', kind: 'DEDUCTION', amount_cent: 5500, period: new Date('2026-07-01T00:00:00Z') });

    const r = await requestAdvance({ userId: 'u1', amountCent: 1000, month: '2026-07' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXCEEDS_ACCRUED_EARNINGS');
  });

  it('rejects non-positive amounts', async () => {
    const r = await requestAdvance({ userId: 'u1', amountCent: 0, month: '2026-07' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_INPUT');
  });
});

describe('decideAdvance', () => {
  it('approves a pending advance and writes an audit row', async () => {
    store.advances.push({
      id: 'adv1',
      user_id: 'u1',
      amount_cent: 5000,
      reason: null,
      status: 'PENDING',
      decided_by: null,
      decided_at: null,
      created_at: new Date('2026-07-10T00:00:00Z'),
    });
    const r = await decideAdvance({ adminId: 'admin', advanceId: 'adv1', decision: 'APPROVED' });
    expect(r.ok).toBe(true);
    const audit = store.audits.find((a) => a.action === 'advance.approve');
    expect(audit).toBeTruthy();
  });

  it('rejects an already-decided advance', async () => {
    store.advances.push({
      id: 'adv2',
      user_id: 'u1',
      amount_cent: 5000,
      reason: null,
      status: 'APPROVED',
      decided_by: 'admin',
      decided_at: new Date(),
      created_at: new Date('2026-07-10T00:00:00Z'),
    });
    const r = await decideAdvance({ adminId: 'admin', advanceId: 'adv2', decision: 'REJECTED' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ALREADY_DECIDED');
  });

  it('returns NOT_FOUND for missing advance', async () => {
    const r = await decideAdvance({ adminId: 'admin', advanceId: 'nope', decision: 'APPROVED' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_FOUND');
  });
});

describe('advancesSummary', () => {
  it('returns pending count and approved balance', async () => {
    store.advances.push(
      { id: 'a', user_id: 'u1', amount_cent: 1000, reason: null, status: 'PENDING', decided_by: null, decided_at: null, created_at: new Date('2026-07-01T00:00:00Z') },
      { id: 'b', user_id: 'u1', amount_cent: 3000, reason: null, status: 'PENDING', decided_by: null, decided_at: null, created_at: new Date('2026-07-01T00:00:00Z') },
      { id: 'c', user_id: 'u1', amount_cent: 4000, reason: null, status: 'APPROVED', decided_by: 'admin', decided_at: new Date(), created_at: new Date('2026-07-01T00:00:00Z') },
    );
    const s = await advancesSummary('u1');
    expect(s.pending).toBe(2);
    expect(s.approved_balance_cent).toBe(4000);
  });
});