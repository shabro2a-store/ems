import { describe, it, expect } from 'vitest';
import { computeCoverage, type PunchLite } from './coverage';
import { computeOvertime } from './overtime';
import { shortfallPenalties } from './penalty';

// Dani's real rows, straight from the production database.
//   schedule 480 min every weekday, rate 264 c/h from 2026-08-31
//   IN  2026-09-01 Tue 18:02 Beirut   OUT 2026-09-02 Wed 02:00
//   IN  2026-09-02 Wed 18:00 Beirut   OUT 2026-09-03 Thu 02:08
// Beirut is UTC+3 in September.
const PUNCHES: PunchLite[] = [
  { kind: 'IN', at: new Date('2026-09-01T15:02:00Z') },
  { kind: 'OUT', at: new Date('2026-09-01T23:00:00Z') },
  { kind: 'IN', at: new Date('2026-09-02T15:00:00Z') },
  { kind: 'OUT', at: new Date('2026-09-02T23:08:00Z') },
];

const RATE = [{ rate_cent: 264, effective_from: new Date('2026-08-31T17:49:11Z') }];

function coverage() {
  return computeCoverage({
    punches: PUNCHES,
    shiftMinByWeekday: new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 480])),
    overridesByDate: new Map(),
    rateCentAt: () => 264,
  });
}

describe("dani's two overnight shifts", () => {
  it('lands each night on the day it started', () => {
    const days = coverage();
    expect(days.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('measures both nights correctly', () => {
    const [tue, wed] = coverage();
    // 18:02 -> 02:00 is 7h58m: two minutes SHORT of the 8h owed.
    expect(tue!.workedMin).toBe(478);
    expect(tue!.deltaMin).toBe(-2);
    // 18:00 -> 02:08 is 8h08m: eight minutes over.
    expect(wed!.workedMin).toBe(488);
    expect(wed!.deltaMin).toBe(8);
  });

  it('prices each night as a day of pay, near enough $21 each', () => {
    const [tue, wed] = coverage();
    expect(tue!.grossCent).toBe(2103); // $21.03
    expect(wed!.grossCent).toBe(2147); // $21.47
  });

  it('reports NO overtime at the default 15 minute grace', () => {
    const items = computeOvertime({
      coverage: coverage(),
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items).toEqual([]);
  });

  it('reports 8 minutes worth 35 cents if the branch grace is 0', () => {
    const items = computeOvertime({
      coverage: coverage(),
      rateChanges: RATE,
      graceMin: 0,
      decisionsByDate: new Map(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ date: '2026-09-02', overtimeMin: 8, amount_cent: 35 });
  });

  it('raises no penalty for the two minutes short', () => {
    expect(
      shortfallPenalties({
        coverage: coverage(),
        rateChanges: RATE,
        graceMin: 15,
        currentShiftDate: '2099-01-01',
        waivers: new Map(),
      }),
    ).toEqual([]);
  });
});

// The owner's own theory: two punches on one calendar day - an OUT closing
// last night's shift, then an IN starting tonight's - might get muddled into
// one long day and reported as overtime. Dani's rows are exactly that shape on
// Wed 2 Sep (OUT 02:00, IN 18:00), and the tests above show they are not.
// These generalise it to the other ways a day can carry more than one pair.
describe('more than one punch on the same calendar day', () => {
  function cover(punches: PunchLite[]) {
    return computeCoverage({
      punches,
      shiftMinByWeekday: new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 480])),
      overridesByDate: new Map(),
      rateCentAt: () => 264,
    });
  }
  const overtime = (punches: PunchLite[]) =>
    computeOvertime({ coverage: cover(punches), rateChanges: RATE, graceMin: 15, decisionsByDate: new Map() });

  it('adds a split shift up instead of treating the second half as extra', () => {
    // 08:00-12:00 then 16:00-20:00 on one day: 8h in two pieces, exactly the
    // 8h owed. Beirut is UTC+3.
    const split: PunchLite[] = [
      { kind: 'IN', at: new Date('2026-09-07T05:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-07T09:00:00Z') },
      { kind: 'IN', at: new Date('2026-09-07T13:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-07T17:00:00Z') },
    ];
    const [day] = cover(split);
    expect(day!.workedMin).toBe(480);
    expect(day!.deltaMin).toBe(0);
    expect(overtime(split)).toEqual([]);
  });

  it('does not merge two nights into one long day', () => {
    // The exact worry: 966 minutes across two nights would be 486 over, worth
    // $21.38 - which is the shape of the figure the owner saw.
    const days = cover(PUNCHES);
    expect(days).toHaveLength(2);
    expect(days.map((d) => d.workedMin)).toEqual([478, 488]);
    expect(days.some((d) => d.workedMin === 966)).toBe(false);
  });

  it('reports overtime only for the part past the day the shift STARTED', () => {
    // A genuine 3h overrun on the second night, so there is something to report
    // and it is 180 minutes - not the night before as well.
    const longer: PunchLite[] = [
      ...PUNCHES.slice(0, 2),
      { kind: 'IN', at: new Date('2026-09-02T15:00:00Z') },
      { kind: 'OUT', at: new Date('2026-09-03T02:00:00Z') },
    ];
    const items = overtime(longer);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ date: '2026-09-02', overtimeMin: 180 });
  });
});
