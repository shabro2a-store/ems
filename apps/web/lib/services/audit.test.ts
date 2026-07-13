import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditLog: { create: vi.fn() },
}));

vi.mock('@/lib/db/prisma', () => ({
  prisma: mocks as unknown as Record<string, unknown>,
}));

import { writeAuditLog } from './audit';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeAuditLog', () => {
  it('writes a row with the expected shape', async () => {
    mocks.auditLog.create.mockResolvedValue({ id: 'a1' });
    await writeAuditLog({
      actorId: 'admin1',
      action: 'advance.approve',
      entity: 'Advance',
      entityId: 'adv1',
      after: { status: 'APPROVED' },
    });
    expect(mocks.auditLog.create).toHaveBeenCalledWith({
      data: {
        actor_id: 'admin1',
        action: 'advance.approve',
        entity: 'Advance',
        entity_id: 'adv1',
        after_json: { status: 'APPROVED' },
      },
    });
  });

  it('includes before_json when provided', async () => {
    mocks.auditLog.create.mockResolvedValue({ id: 'a2' });
    await writeAuditLog({
      actorId: 'admin1',
      action: 'punch.correct',
      entity: 'Punch',
      entityId: 'p1',
      before: { at: '2026-07-01T08:00:00Z' },
      after: { at: '2026-07-01T09:00:00Z' },
    });
    const call = mocks.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.before_json).toEqual({ at: '2026-07-01T08:00:00Z' });
    expect(call.data.after_json).toEqual({ at: '2026-07-01T09:00:00Z' });
  });

  it('omits before_json / after_json when not provided', async () => {
    mocks.auditLog.create.mockResolvedValue({ id: 'a3' });
    await writeAuditLog({
      actorId: 'admin1',
      action: 'advance.create',
      entity: 'Advance',
      entityId: 'adv2',
    });
    const call = mocks.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect('before_json' in call.data).toBe(false);
    expect('after_json' in call.data).toBe(false);
  });
});