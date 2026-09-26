import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { scheduledToUtc, nextBeirutDate } from 'time';
import { computePayoutFromRows, payoutForUser } from './payout';
import { requiredMinForArrival } from './autoClose';
import { weekdayOfWorkingDay } from './coverage';

/*
 * A night worker whose working days run one date ahead of the calendar, across
 * a month seam, read through the real month queries.
 *
 * They start once at 00:02 on 20 September (that date is theirs), then every night
 * at 23:00. Each 23:00 arrival lands on a date the night before already took,
 * so every shift is filed on the date it ENDS: the 30 September night is
 * 1 October's working day, and the 31 October night is 1 November's.
 */
type Row = { id: string; user_id: string; kind: 'IN' | 'OUT'; at: Date };

const USER = 'u-night';
const RATE_CENT = 600; // 10 cents a minute, so gross is minutes x 10 exactly

function nightRun(): Row[] {
  const rows: Row[] = [];
  const add = (kind: 'IN' | 'OUT', at: Date) => rows.push({ id: `p${rows.length}`, user_id: USER, kind, at });
  add('IN', scheduledToUtc('2026-09-20', '00:02'));
  add('OUT', scheduledToUtc('2026-09-20', '07:00'));
  for (let d = '2026-09-20'; d <= '2026-10-31'; d = nextBeirutDate(d)) {
    add('IN', scheduledToUtc(d, '23:00'));
    add('OUT', scheduledToUtc(nextBeirutDate(d), '07:00'));
  }
  return rows;
}

/**
 * Just enough of Prisma for the payroll path: punches honour the `at` window a
 * query asks for - which is the whole question here - and every other table is
 * empty apart from the rate and the user.
 */
function fakeDb(punches: Row[], shiftMinByWeekday = new Map<number, number>()): PrismaClient {
  const inWindow = (at: Date, w: { gte?: Date; gt?: Date; lt?: Date; lte?: Date } | undefined) =>
    !w ||
    ((w.gte === undefined || at >= w.gte) &&
      (w.gt === undefined || at > w.gt) &&
      (w.lt === undefined || at < w.lt) &&
      (w.lte === undefined || at <= w.lte));
  const user = { id: USER, day_start_hour: 0, role: 'EMPLOYEE', branch: { shift_grace_min: 15 } };
  const rate = { user_id: USER, rate_cent: RATE_CENT, effective_from: new Date('2026-01-01T00:00:00Z') };
  const models: Record<string, unknown> = {
    punch: {
      findMany: async ({ where }: { where: { at?: Parameters<typeof inWindow>[1] } }) =>
        punches.filter((p) => inWindow(p.at, where.at)).sort((a, b) => a.at.getTime() - b.at.getTime()),
    },
    rateChange: { findMany: async () => [rate] },
    user: { findUnique: async () => user, findMany: async () => [user] },
    schedule: {
      findMany: async () => [...shiftMinByWeekday].map(([weekday, shift_min]) => ({ weekday, shift_min })),
      findUnique: async ({ where }: { where: { user_id_weekday: { weekday: number } } }) => {
        const shift_min = shiftMinByWeekday.get(where.user_id_weekday.weekday);
        return shift_min === undefined ? null : { shift_min };
      },
    },
  };
  const empty = { findMany: async () => [], findUnique: async () => null, findFirst: async () => null };
  return new Proxy(models, { get: (t, k: string) => t[k] ?? empty }) as unknown as PrismaClient;
}

describe('a night worker across the month seam, read month by month', () => {
  const punches = nightRun();
  const db = fakeDb(punches);

  it('pays every shift exactly once across the months it spans', async () => {
    const everyShift = computePayoutFromRows({
      userId: USER,
      punches: punches as never,
      rateChanges: [{ user_id: USER, rate_cent: RATE_CENT, effective_from: new Date('2026-01-01T00:00:00Z') }] as never,
      adjustments: [],
      approvedAdvances: [],
    }).grossCent;

    const months = ['2026-09', '2026-10', '2026-11'];
    const paid = await Promise.all(months.map((m) => payoutForUser(USER, m, db)));
    expect(paid.reduce((s, p) => s + p.grossCent, 0)).toBe(everyShift);
  });

  it('files the 30 September night in October, where the chain puts it', async () => {
    // 00:02-07:00 on the 20th, then ten nights 20th-29th: 418 + 10 x 480 min.
    expect((await payoutForUser(USER, '2026-09', db)).grossCent).toBe((418 + 10 * 480) * 10);
    // The 30 September night through the 30 October night: 31 nights.
    expect((await payoutForUser(USER, '2026-10', db)).grossCent).toBe(31 * 480 * 10);
    // The 31 October night is 1 November's working day.
    expect((await payoutForUser(USER, '2026-11', db)).grossCent).toBe(480 * 10);
  });
});

describe('the auto-close, asking which day a night of that chain is', () => {
  it('reads the schedule of the day payroll files the night under', async () => {
    // The 20 October 23:00 arrival is 21 October's working day in the chain.
    // Its required hours are that day's, not the calendar date's it began on.
    const schedule = new Map([
      [weekdayOfWorkingDay('2026-10-20'), 480],
      [weekdayOfWorkingDay('2026-10-21'), 420],
    ]);
    const db = fakeDb(nightRun(), schedule);
    const arrival = scheduledToUtc('2026-10-20', '23:00');
    expect(await requiredMinForArrival(db, USER, arrival)).toBe(420);
  });
});
