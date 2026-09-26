import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { revokeSystemCheckout } from './revokeAutoClose';
import { punchLockKey } from './punch';

/*
 * Revoking an auto-close reopens the shift it closed. If the employee has
 * punched since, reopening pairs the old arrival with the NEW shift's checkout:
 * in Monday 07:00, system out Monday 15:00, in again Tuesday 07:00, out Tuesday
 * 15:00 - revoke, and payroll pays 32 hours on Monday and nothing on Tuesday.
 */
type Row = { id: string; user_id: string; kind: 'IN' | 'OUT'; at: Date };

function fakeDb(rows: Row[]) {
  const log: string[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`lock ${String(values[0])}`);
      return 1;
    },
    punch: {
      findFirst: async ({ where }: { where: { user_id: string; at: { gt: Date } } }) => {
        log.push('read');
        return rows.find((r) => r.user_id === where.user_id && r.at > where.at.gt) ?? null;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        log.push(`delete ${where.id}`);
        return rows.find((r) => r.id === where.id);
      },
      update: async ({ where, data }: { where: { id: string }; data: unknown }) => {
        log.push(`update ${where.id} ${JSON.stringify(data)}`);
        return {};
      },
    },
  };
  const db = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { db: db as unknown as PrismaClient, log };
}

const monIn: Row = { id: 'in1', user_id: 'u', kind: 'IN', at: new Date('2026-10-12T04:00:00Z') };
const systemOut: Row = { id: 'out1', user_id: 'u', kind: 'OUT', at: new Date('2026-10-12T12:00:00Z') };
const tueIn: Row = { id: 'in2', user_id: 'u', kind: 'IN', at: new Date('2026-10-13T04:00:00Z') };
const revokedAt = new Date('2026-10-13T05:00:00Z');
const args = { userId: 'u', outId: 'out1', outAt: systemOut.at, arrivalId: 'in1', revokedAt };

describe('revoking a system checkout', () => {
  it('refuses once the employee has punched again, and changes nothing', async () => {
    const { db, log } = fakeDb([monIn, systemOut, tueIn]);
    const result = await revokeSystemCheckout(db, args);
    expect(result).toEqual({ refused: 'PUNCHED_SINCE', at: tueIn.at });
    expect(log.some((l) => l.startsWith('delete') || l.startsWith('update'))).toBe(false);
  });

  it('reopens the shift when nothing has happened since', async () => {
    const { db, log } = fakeDb([monIn, systemOut]);
    const result = await revokeSystemCheckout(db, args);
    expect(result).toEqual({ revoked: true });
    expect(log).toContain('delete out1');
    expect(log).toContain(`update in1 ${JSON.stringify({ auto_close_revoked_at: revokedAt })}`);
  });

  it('asks under the same per-person lock every punch takes', async () => {
    // Otherwise a check-in landing between the read and the delete slips past.
    const { db, log } = fakeDb([monIn, systemOut]);
    await revokeSystemCheckout(db, args);
    expect(log[0]).toBe(`lock ${punchLockKey('u')}`);
    expect(log[1]).toBe('read');
  });
});
