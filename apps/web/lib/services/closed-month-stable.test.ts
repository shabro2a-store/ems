import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import { scheduledToUtc, todayInBeirut, nextBeirutDate } from 'time';
import { fakeDb, type Row } from '../test-helpers/fakePrisma';
import { penaltiesForUser } from './penalty';
import { payoutForUser, payrollRoster } from './payout';
import { decideLeave } from './leave';

/*
 * #19: a month that closed and was paid still moved afterwards, because
 * payroll is recomputed from today's state:
 *  - editing the weekly hours re-judged every past day against the new hours;
 *  - a driver moved to another role lost every trip they had been paid for;
 *  - a person who became a caller vanished from the payrolls they were on;
 *  - a person moved to another branch took their history with them;
 *  - leave could be approved into a month already settled.
 */
const USER = 'u1';
const shift = (day: string, from: string, to: string, n: number, branch = 'b1'): Row[] => [
  { id: `in${n}`, user_id: USER, branch_id: branch, kind: 'IN', at: scheduledToUtc(day, from) },
  { id: `out${n}`, user_id: USER, branch_id: branch, kind: 'OUT', at: scheduledToUtc(day, to) },
];
const rate = { id: 'r1', user_id: USER, rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') };
const since = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe('a paid month does not move', () => {
  it('when the weekly hours change later', async () => {
    // Monday 14 September, worked 08:00-16:00 against the 8h then in force.
    // In October the owner raises Mondays to 9h. September stays as paid.
    const db = fakeDb({
      punch: shift('2026-09-14', '08:00', '16:00', 1),
      rateChange: [rate],
      schedule: [
        { id: 's1', user_id: USER, weekday: 1, shift_min: 480, effective_from: since('1970-01-01') },
        { id: 's2', user_id: USER, weekday: 1, shift_min: 540, effective_from: since('2026-10-05') },
      ],
      user: [{ id: USER, day_start_hour: null, role: 'EMPLOYEE', branch: { shift_grace_min: 15 } }],
    });
    const penalties = await penaltiesForUser(USER, '2026-09', db, { now: scheduledToUtc('2026-10-06', '12:00') });
    expect(penalties.filter((p) => p.date === '2026-09-14')).toEqual([]);
  });

  it('when a driver becomes an employee', async () => {
    const db = fakeDb({
      punch: shift('2026-09-14', '08:00', '16:00', 1),
      rateChange: [rate],
      user: [{ id: USER, day_start_hour: null, role: 'EMPLOYEE', branch: { shift_grace_min: 15 } }],
      trip: [
        { id: 't1', driver_id: USER, out_at: scheduledToUtc('2026-09-14', '10:00'), back_at: scheduledToUtc('2026-09-14', '10:30'), denied_at: null },
        { id: 't2', driver_id: USER, out_at: scheduledToUtc('2026-09-14', '12:00'), back_at: scheduledToUtc('2026-09-14', '12:40'), denied_at: null },
      ],
      tripRateChange: [{ id: 'tr1', user_id: USER, rate_cent: 150, effective_from: new Date('2026-01-01T00:00:00Z') }],
    });
    const paid = await payoutForUser(USER, '2026-09', db);
    expect(paid.tripsCount).toBe(2);
    expect(paid.tripsCent).toBe(300);
  });

  it('when the person becomes a caller or moves branch, they stay on the payroll where they worked', async () => {
    const worked = { id: USER, username: 'moved', name: null, role: 'CALLER', branch_id: 'b2', is_active: true, deleted_at: null, day_start_hour: null };
    const stayed = { id: 'u2', username: 'stayed', name: null, role: 'EMPLOYEE', branch_id: 'b1', is_active: true, deleted_at: null, day_start_hour: null };
    const db = fakeDb({
      punch: [...shift('2026-09-14', '08:00', '16:00', 1, 'b1'), ...shift('2026-09-15', '08:00', '16:00', 2, 'b1')],
      user: [worked, stayed],
    });
    expect((await payrollRoster(db, '2026-09', 'b1')).map((u) => u.id).sort()).toEqual([USER, 'u2']);
    expect((await payrollRoster(db, '2026-09', 'b2')).map((u) => u.id)).toEqual([]);
    const row = (await payrollRoster(db, '2026-09', null)).find((u) => u.id === USER)!;
    expect(row.branch_id).toBe('b1');
  });
});

describe('leave into a settled month', () => {
  const leave = (start: string, end: string): Row => ({
    id: 'l1', user_id: USER, kind: 'DAY_OFF', status: 'PENDING', off_min: null, note: null,
    start_date: new Date(`${start}T00:00:00.000Z`), end_date: new Date(`${end}T00:00:00.000Z`),
  });

  it('cannot be approved, and nothing is written', async () => {
    const tables = { leaveRequest: [leave('2026-08-10', '2026-08-11')], scheduleOverride: [] as Row[] };
    const r = await decideLeave({ adminId: 'admin', leaveId: 'l1', decision: 'APPROVED', db: fakeDb(tables) });
    expect(r).toMatchObject({ ok: false, code: 'MONTH_CLOSED' });
    expect(tables.scheduleOverride).toHaveLength(0);
    expect(tables.leaveRequest[0]!.status).toBe('PENDING');
  });

  it('can still be refused', async () => {
    const tables = { leaveRequest: [leave('2026-08-10', '2026-08-11')] };
    expect(await decideLeave({ adminId: 'admin', leaveId: 'l1', decision: 'REJECTED', db: fakeDb(tables) })).toMatchObject({ ok: true });
  });

  it('is approved as before for days still open', async () => {
    const day = nextBeirutDate(nextBeirutDate(todayInBeirut()));
    const tables = { leaveRequest: [leave(day, day)], scheduleOverride: [] as Row[] };
    expect(await decideLeave({ adminId: 'admin', leaveId: 'l1', decision: 'APPROVED', db: fakeDb(tables) })).toMatchObject({ ok: true });
    expect(tables.scheduleOverride).toHaveLength(1);
  });
});
