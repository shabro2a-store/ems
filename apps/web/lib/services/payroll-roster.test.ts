import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import { scheduledToUtc, nextBeirutDate } from 'time';
import { payrollRoster } from './payout';

type UserRow = {
  id: string;
  username: string;
  name: string | null;
  role: string;
  branch_id: string | null;
  is_active: boolean;
  deleted_at: Date | null;
};
type PunchRow = { user_id: string; kind: 'IN' | 'OUT'; at: Date };

function fakeDb(users: UserRow[], punches: PunchRow[]) {
  return {
    punch: {
      // Two shapes: every arrival in the month's window, and one person's
      // history up to an arrival, which the roster reads to settle the seam.
      findMany: async ({
        where,
      }: {
        where: { kind?: 'IN'; user_id?: string; at: { gte: Date; lt?: Date; lte?: Date } };
      }) =>
        punches
          .filter((p) => (where.kind ? p.kind === where.kind : true))
          .filter((p) => (where.user_id ? p.user_id === where.user_id : true))
          .filter((p) => p.at >= where.at.gte)
          .filter((p) => (where.at.lt ? p.at < where.at.lt : true))
          .filter((p) => (where.at.lte ? p.at <= where.at.lte : true))
          .sort((a, b) => a.at.getTime() - b.at.getTime())
          .map((p) => ({ user_id: p.user_id, kind: p.kind, at: p.at })),
    },
    user: {
      findMany: async ({
        where,
      }: {
        where: {
          id?: { in: string[] };
          role?: { in: string[] };
          branch_id?: string;
          OR?: [{ is_active: boolean; deleted_at: null }, { id: { in: string[] } }];
        };
      }) => {
        // payrollRoster asks twice: first for each arriving user's branch
        // boundary, then for the roster itself.
        if (!where.OR) {
          const ids = new Set(where.id?.in ?? []);
          return users.filter((u) => ids.has(u.id)).map((u) => ({ id: u.id, branch: null }));
        }
        const worked = new Set(where.OR[1].id.in);
        return users
          .filter((u) => (where.role ? where.role.in.includes(u.role) : true))
          .filter((u) => (where.branch_id ? u.branch_id === where.branch_id : true))
          .filter((u) => (u.is_active && u.deleted_at === null) || worked.has(u.id))
          .map((u) => ({ ...u, hourly_rate_cent: 300, expected_monthly_salary_cent: null, branch: null }));
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const staff = (over: Partial<UserRow> & { id: string }): UserRow => ({
  username: over.id,
  name: null,
  role: 'EMPLOYEE',
  branch_id: 'b1',
  is_active: true,
  deleted_at: null,
  ...over,
});

// Beirut is UTC+2 in winter.
const janShift = (id: string): PunchRow => ({
  user_id: id,
  kind: 'IN',
  at: new Date('2026-01-15T06:00:00Z'),
});

describe('payrollRoster', () => {
  it('keeps a retired employee on the month they worked', async () => {
    // The owner deletes somebody who quit in January. January still owes them.
    const retired = staff({
      id: 'quit',
      is_active: false,
      deleted_at: new Date('2026-01-20T00:00:00Z'),
      username: 'ali#a1b2c3d4',
      name: 'ali',
    });
    const db = fakeDb([staff({ id: 'current' }), retired], [janShift('quit')]);

    const jan = await payrollRoster(db, '2026-01', null);
    expect(jan.map((u) => u.id).sort()).toEqual(['current', 'quit']);
    // And readable as a person, not as the parked username.
    expect(jan.find((u) => u.id === 'quit')?.name).toBe('ali');
  });

  it('drops them the month after, with nothing having to expire them', async () => {
    // No job sweeps them up. They are absent from February because they have
    // no arrivals in February - that is the whole mechanism.
    const retired = staff({ id: 'quit', is_active: false, deleted_at: new Date('2026-01-20T00:00:00Z') });
    const db = fakeDb([staff({ id: 'current' }), retired], [janShift('quit')]);

    expect((await payrollRoster(db, '2026-02', null)).map((u) => u.id)).toEqual(['current']);
  });

  it('still lists somebody on the staff who did nothing this month', async () => {
    // A zero row, not a missing row - "he earned nothing" and "he is not here"
    // are different answers and the screen has to be able to say the first.
    const db = fakeDb([staff({ id: 'idle' })], []);
    expect((await payrollRoster(db, '2026-02', null)).map((u) => u.id)).toEqual(['idle']);
  });

  it('does not lose a month you still owe when somebody is deactivated', async () => {
    // The bug this replaced: the roster was `is_active: true`, so suspending
    // somebody in January blanked January's payroll row while their punches sat
    // untouched in the database.
    const suspended = staff({ id: 'suspended', is_active: false });
    const db = fakeDb([suspended], [janShift('suspended')]);
    expect((await payrollRoster(db, '2026-01', null)).map((u) => u.id)).toEqual(['suspended']);
  });

  it('decides the month by the arrival, so the night of the 31st counts once', async () => {
    // 31 Jan 21:00 Beirut = 31 Jan 19:00 UTC, finishing in February. The person
    // belongs to January, the month the shift began - the same rule payroll
    // pays by, so the roster and the money cannot disagree.
    const nightShift: PunchRow = { user_id: 'night', kind: 'IN', at: new Date('2026-01-31T19:00:00Z') };
    const worker = staff({ id: 'night', is_active: false, deleted_at: new Date('2026-02-02T00:00:00Z') });
    const db = fakeDb([worker], [nightShift]);

    expect((await payrollRoster(db, '2026-01', null)).map((u) => u.id)).toEqual(['night']);
    expect((await payrollRoster(db, '2026-02', null)).map((u) => u.id)).toEqual([]);
  });

  it('follows a night chain that files the last night on the 1st', async () => {
    // Retired on 2 December after a run of nights that began with one 00:02
    // start, so every 23:00 arrival after it is filed on the next date and the
    // 30 November night is 1 December's working day. December pays it, so
    // December must list them, although no arrival of theirs is in December.
    const rows: PunchRow[] = [
      { user_id: 'chain', kind: 'IN', at: scheduledToUtc('2026-11-20', '00:02') },
      { user_id: 'chain', kind: 'OUT', at: scheduledToUtc('2026-11-20', '07:00') },
    ];
    for (let d = '2026-11-20'; d <= '2026-11-30'; d = nextBeirutDate(d)) {
      rows.push({ user_id: 'chain', kind: 'IN', at: scheduledToUtc(d, '23:00') });
      rows.push({ user_id: 'chain', kind: 'OUT', at: scheduledToUtc(nextBeirutDate(d), '07:00') });
    }
    const worker = staff({ id: 'chain', is_active: false, deleted_at: new Date('2026-12-02T12:00:00Z') });
    const db = fakeDb([worker], rows);

    expect((await payrollRoster(db, '2026-12', null)).map((u) => u.id)).toEqual(['chain']);
  });

  it('respects the branch filter', async () => {
    const db = fakeDb([staff({ id: 'a', branch_id: 'b1' }), staff({ id: 'b', branch_id: 'b2' })], []);
    expect((await payrollRoster(db, '2026-02', 'b2')).map((u) => u.id)).toEqual(['b']);
  });
});
