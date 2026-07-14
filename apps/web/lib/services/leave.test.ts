import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  leaves: [] as Array<{ id: string; user_id: string; kind: 'DAY_OFF' | 'TIME_CHANGE'; start_date: Date; end_date: Date; start_time: string | null; end_time: string | null; note: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED'; decided_by: string | null; decided_at: Date | null; created_at: Date }>,
  overrides: [] as Array<{ user_id: string; date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE'; start_time: string | null; end_time: string | null; note: string | null; source: string }>,
  audits: [] as Array<{ action: string; entity: string; entity_id: string }>,
  leafSeq: 0,
  auditSeq: 0,
};

const mocks = vi.hoisted(() => ({
  leaveRequest: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  scheduleOverride: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  transaction: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    leaveRequest: mocks.leaveRequest,
    scheduleOverride: mocks.scheduleOverride,
    auditLog: mocks.auditLog,
    $transaction: mocks.transaction,
  },
}));

import { requestLeave, decideLeave, leaveSummary } from './leave';

function resetStore() {
  store.leaves.length = 0;
  store.overrides.length = 0;
  store.audits.length = 0;
  store.leafSeq = 0;
  store.auditSeq = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();

  mocks.leaveRequest.create.mockImplementation(async ({ data }: { data: { user_id: string; kind: 'DAY_OFF' | 'TIME_CHANGE'; start_date: Date; end_date: Date; start_time?: string | null; end_time?: string | null; note?: string | null } }) => {
    store.leafSeq += 1;
    const l = {
      id: `l${store.leafSeq}`,
      user_id: data.user_id,
      kind: data.kind,
      start_date: data.start_date,
      end_date: data.end_date,
      start_time: data.start_time ?? null,
      end_time: data.end_time ?? null,
      note: data.note ?? null,
      status: 'PENDING' as const,
      decided_by: null,
      decided_at: null,
      created_at: new Date(),
    };
    store.leaves.push(l);
    return l;
  });

  mocks.leaveRequest.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    return store.leaves.find((l) => l.id === where.id) ?? null;
  });

  mocks.leaveRequest.findMany.mockImplementation(async ({ where }: { where?: { user_id?: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' } }) => {
    return store.leaves.filter((l) => (!where?.user_id || l.user_id === where.user_id) && (!where?.status || l.status === where.status));
  });

  mocks.leaveRequest.count.mockImplementation(async ({ where }: { where?: { user_id?: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' } }) => {
    return store.leaves.filter((l) => (!where?.user_id || l.user_id === where.user_id) && (!where?.status || l.status === where.status)).length;
  });

  mocks.leaveRequest.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<{ status: 'PENDING' | 'APPROVED' | 'REJECTED'; decided_by: string; decided_at: Date }> }) => {
    const l = store.leaves.find((x) => x.id === where.id);
    if (!l) throw new Error('not found');
    Object.assign(l, data);
    return l;
  });

  mocks.scheduleOverride.upsert.mockImplementation(async ({ where, create, update }: { where: { user_id_date: { user_id: string; date: Date } }; create: { user_id: string; date: Date; kind: 'DAY_OFF' | 'TIME_CHANGE'; start_time: string | null; end_time: string | null; note: string | null; source: string }; update: Partial<{ kind: 'DAY_OFF' | 'TIME_CHANGE'; start_time: string | null; end_time: string | null; note: string | null; source: string }> }) => {
    let existing = store.overrides.find((o) => o.user_id === where.user_id_date.user_id && o.date.getTime() === where.user_id_date.date.getTime());
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    existing = { ...create };
    store.overrides.push(existing);
    return existing;
  });

  mocks.scheduleOverride.findMany.mockImplementation(async ({ where }: { where: { user_id: string; date?: { gte: Date } } }) => {
    return store.overrides.filter((o) => o.user_id === where.user_id && (!where.date?.gte || o.date >= where.date.gte));
  });

  mocks.auditLog.create.mockImplementation(async ({ data }: { data: { actor_id: string; action: string; entity: string; entity_id: string } }) => {
    store.auditSeq += 1;
    const a = { id: `a${store.auditSeq}`, action: data.action, entity: data.entity, entity_id: data.entity_id };
    store.audits.push(a);
    return a;
  });

  mocks.transaction.mockImplementation(async (fn: (tx: typeof mocks) => Promise<unknown>) => fn(mocks));
});

describe('requestLeave', () => {
  it('creates a leave request and writes audit row', async () => {
    const r = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '2026-12-01', endDate: '2026-12-03' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('PENDING');
    const audit = store.audits.find((a) => a.action === 'leave.create' && a.entity === 'LeaveRequest');
    expect(audit).toBeTruthy();
  });

  it('rejects past start_date with PAST_DATE', async () => {
    const r = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '2020-01-01', endDate: '2020-01-02' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PAST_DATE');
  });

  it('rejects invalid date format with INVALID_INPUT', async () => {
    const r = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '12-01-2026', endDate: '2026-12-03' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_INPUT');
  });

  it('rejects invalid time format with INVALID_INPUT', async () => {
    const r = await requestLeave({ userId: 'u1', kind: 'TIME_CHANGE', startDate: '2026-12-01', endDate: '2026-12-01', startTime: '9am' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_INPUT');
  });
});

describe('decideLeave APPROVED', () => {
  it('writes one ScheduleOverride per date in range', async () => {
    const cr = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '2026-12-01', endDate: '2026-12-03' });
    if (!cr.ok) throw new Error('create failed');
    const r = await decideLeave({ adminId: 'admin', leaveId: cr.id, decision: 'APPROVED' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('APPROVED');
      expect(r.overrides_created).toBe(3);
    }
    expect(store.overrides.length).toBe(3);
  });

  it('writes one ScheduleOverride for a single-day leave', async () => {
    const cr = await requestLeave({ userId: 'u1', kind: 'TIME_CHANGE', startDate: '2026-12-01', endDate: '2026-12-01', startTime: '10:00', endTime: '14:00' });
    if (!cr.ok) throw new Error('create failed');
    const r = await decideLeave({ adminId: 'admin', leaveId: cr.id, decision: 'APPROVED' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides_created).toBe(1);
  });

  it('rejects unknown leave with NOT_FOUND', async () => {
    const r = await decideLeave({ adminId: 'admin', leaveId: 'nope', decision: 'APPROVED' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_FOUND');
  });
});

describe('decideLeave REJECTED', () => {
  it('marks rejected and writes audit, no overrides created', async () => {
    const cr = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '2026-12-01', endDate: '2026-12-02' });
    if (!cr.ok) throw new Error('create failed');
    const r = await decideLeave({ adminId: 'admin', leaveId: cr.id, decision: 'REJECTED' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides_created).toBe(0);
    expect(store.overrides.length).toBe(0);
  });
});

describe('leaveSummary', () => {
  it('returns pending count and upcoming overrides', async () => {
    store.overrides.push(
      { user_id: 'u1', date: new Date('2026-12-01T00:00:00.000Z'), kind: 'DAY_OFF', start_time: null, end_time: null, note: null, source: 'ADMIN_DIRECT' },
    );
    const cr = await requestLeave({ userId: 'u1', kind: 'DAY_OFF', startDate: '2026-12-05', endDate: '2026-12-05' });
    if (!cr.ok) throw new Error('create failed');
    const s = await leaveSummary('u1');
    expect(s.pending).toBe(1);
    expect(s.upcoming.length).toBeGreaterThanOrEqual(1);
  });
});