import { describe, it, expect } from 'vitest';
import { computeCoverage, dayStartHourFor, type PunchLite } from './coverage';
import { computeOvertime } from './overtime';

/*
 * The day that went missing, and the setting that stops it.
 *
 * Bilal's real punches. Beirut is UTC+3 in summer:
 *   Mon 31 Aug 07:05 -> 16:09   nine hours, a normal day
 *   Tue  1 Sep 00:24 -> 16:34   sixteen hours, started 24 minutes after midnight
 *
 * His branch's working day starts at 04:00, for the night workers who share it.
 * That boundary files the second shift under 31 August - a day already worked -
 * so the two stack onto one day: 25h14m against 17h owed, eight hours of
 * overtime nobody worked, and sixteen hours of September's work paid in August.
 * September then read seventeen hours light with nothing to point at.
 *
 * The branch cannot be changed: dani is on it and genuinely needs 04:00. The
 * fix is that Bilal is not dani.
 */
const RATE = [{ rate_cent: 264, effective_from: new Date('2020-01-01T00:00:00Z') }];
const SEVENTEEN_HOURS = new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 1020]));

const PUNCHES: PunchLite[] = [
  { kind: 'IN', at: new Date('2026-08-31T04:05:00Z') }, // Mon 31 Aug 07:05
  { kind: 'OUT', at: new Date('2026-08-31T13:09:00Z') }, // Mon 31 Aug 16:09
  { kind: 'IN', at: new Date('2026-08-31T21:24:00Z') }, // Tue 1 Sep 00:24
  { kind: 'OUT', at: new Date('2026-09-01T13:34:00Z') }, // Tue 1 Sep 16:34
];

const cover = (dayStartHour: number) =>
  computeCoverage({
    punches: PUNCHES,
    shiftMinByWeekday: SEVENTEEN_HOURS,
    overridesByDate: new Map(),
    rateCentAt: () => 264,
    dayStartHour,
  });

describe("Bilal's branch keeps its 04:00 boundary", () => {
  const BRANCH_ONLY = { day_start_hour: null, branch: { day_start_hour: 4 } };

  it('and that is what loses the day', () => {
    const days = cover(dayStartHourFor(BRANCH_ONLY));
    expect(days.map((d) => d.date)).toEqual(['2026-08-31']);
    expect(days[0]!.workedMin).toBe(544 + 970); // 25h14m on one day
    expect(days[0]!.deltaMin).toBe(494); // 8h14m of overtime nobody worked

    const [ot] = computeOvertime({
      coverage: days,
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(ot!.overtimeMin).toBe(494);
    // And the whole of it is August's, so September is short and August is
    // closed before anybody notices.
    expect(days.every((d) => d.date.slice(0, 7) === '2026-08')).toBe(true);
  });
});

describe('with his own boundary at midnight', () => {
  const HIS_OWN = { day_start_hour: 0, branch: { day_start_hour: 4 } };

  it('resolves to 0 even though his branch says 4', () => {
    // `??`, not `||`. An explicit 0 is the answer here, not a missing value.
    expect(dayStartHourFor(HIS_OWN)).toBe(0);
  });

  it('gives him two days, in the two months he worked them', () => {
    const days = cover(dayStartHourFor(HIS_OWN));
    expect(days.map((d) => d.date)).toEqual(['2026-08-31', '2026-09-01']);
    expect(days.map((d) => d.workedMin)).toEqual([544, 970]);
    expect(days[1]!.date.slice(0, 7)).toBe('2026-09'); // the day that was missing
  });

  it('and no overtime at all', () => {
    // Nine hours short on one day and one hour short on the other, against 17h
    // owed. Neither is over, so the phantom eight hours simply do not exist.
    const days = cover(dayStartHourFor(HIS_OWN));
    expect(days.map((d) => d.deltaMin)).toEqual([-476, -50]);
    expect(
      computeOvertime({ coverage: days, rateChanges: RATE, graceMin: 15, decisionsByDate: new Map() }),
    ).toEqual([]);
  });
});

describe('dani, on the same branch, is untouched', () => {
  it('still gets both halves of one night on one day', () => {
    // 23:00 one night and 00:02 the next are one shift pattern, not two days.
    // This is what the branch boundary is FOR, and it has to keep working.
    const dani = { day_start_hour: null, branch: { day_start_hour: 4 } };
    const nights: PunchLite[] = [
      { kind: 'IN', at: new Date('2026-09-01T20:00:00Z') }, // Tue 23:00
      { kind: 'OUT', at: new Date('2026-09-02T04:00:00Z') }, // Wed 07:00
    ];
    const days = computeCoverage({
      punches: nights,
      shiftMinByWeekday: new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 480])),
      overridesByDate: new Map(),
      rateCentAt: () => 264,
      dayStartHour: dayStartHourFor(dani),
    });
    expect(dayStartHourFor(dani)).toBe(4);
    expect(days.map((d) => d.date)).toEqual(['2026-09-01']);
    expect(days[0]!.workedMin).toBe(480);
  });
});
