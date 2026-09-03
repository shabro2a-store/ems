import { describe, it, expect } from 'vitest';
import { computeCoverage, type PunchLite } from './coverage';
import { computeOvertime } from './overtime';
import { shortfallPenalties } from './penalty';
import { monthRangeUtc, PAIR_LOOKAROUND_MS } from './payout';

/*
 * The last night of a month, for penalties and overtime.
 *
 * penaltiesForUser and overtimeForUser windowed their punch query by the plain
 * UTC month. A shift starting on the 30th and ending on the 1st has its
 * CHECKOUT outside that window, so coverage was handed an arrival with no
 * departure - an unclosed day, and an unclosed day is never judged. The next
 * month saw a checkout with no arrival and ignored it. So the last night of
 * every month raised no overtime and no penalty, in either month, for every
 * overnight worker.
 *
 * Payroll already read two days either side for exactly this reason; these
 * three now do the same and filter the days back to the month.
 */

const RATE = [{ rate_cent: 264, effective_from: new Date('2020-01-01T00:00:00Z') }];
const SCHEDULE = new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 480]));

// Beirut is UTC+3 in September: in 30 Sep 21:00, out 1 Oct 07:00. Ten hours
// against eight owed - two hours over, and two hours is well past any grace.
const NIGHT: PunchLite[] = [
  { kind: 'IN', at: new Date('2026-09-30T18:00:00Z') },
  { kind: 'OUT', at: new Date('2026-10-01T04:00:00Z') },
];

/** Exactly the window the services now send to Postgres, and their month filter. */
function judge(month: string, punches: PunchLite[]) {
  const { start, end } = monthRangeUtc(month);
  const from = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const to = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const coverage = computeCoverage({
    punches: punches.filter((p) => p.at >= from && p.at < to),
    shiftMinByWeekday: SCHEDULE,
    overridesByDate: new Map(),
    rateCentAt: () => 264,
  });
  return {
    overtime: computeOvertime({ coverage, rateChanges: RATE, graceMin: 15, decisionsByDate: new Map() })
      .filter((o) => o.date.slice(0, 7) === month),
    penalties: shortfallPenalties({
      coverage,
      rateChanges: RATE,
      graceMin: 15,
      currentShiftDate: '2099-01-01',
      waivers: new Map(),
    }).filter((p) => p.date.slice(0, 7) === month),
  };
}

describe('the last night of a month', () => {
  it('is judged for its overtime, once, in the month it started', () => {
    const sep = judge('2026-09', NIGHT);
    const oct = judge('2026-10', NIGHT);

    expect(sep.overtime).toHaveLength(1);
    expect(sep.overtime[0]).toMatchObject({ date: '2026-09-30', overtimeMin: 120 });
    // And not a second time in October - counting it twice is the other way to
    // get this wrong, and would let one night be revoked out of two months.
    expect(oct.overtime).toEqual([]);
  });

  it('is judged for a shortfall the same way', () => {
    // In 30 Sep 21:00, out 1 Oct 02:00: five hours against eight owed.
    const short: PunchLite[] = [
      { kind: 'IN', at: new Date('2026-09-30T18:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-30T23:00:00Z') },
    ];
    const sep = judge('2026-09', short);
    expect(sep.penalties).toHaveLength(1);
    expect(sep.penalties[0]).toMatchObject({ date: '2026-09-30', shortfallMin: 180 });
    expect(judge('2026-10', short).penalties).toEqual([]);
  });

  it('does not drag the previous month into this one', () => {
    // A night on 31 Aug is August's business, however wide October reads.
    const august: PunchLite[] = [
      { kind: 'IN', at: new Date('2026-08-31T18:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-01T04:00:00Z') },
    ];
    expect(judge('2026-09', august).overtime).toEqual([]);
    expect(judge('2026-08', august).overtime).toHaveLength(1);
  });

  it('leaves an ordinary mid-month night exactly as it was', () => {
    const midMonth: PunchLite[] = [
      { kind: 'IN', at: new Date('2026-09-15T18:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-16T04:00:00Z') },
    ];
    expect(judge('2026-09', midMonth).overtime).toHaveLength(1);
    expect(judge('2026-10', midMonth).overtime).toEqual([]);
  });
});
