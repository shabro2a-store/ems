import { describe, it, expect } from 'vitest';
import { computeCoverage, type PunchLite } from './coverage';
import { computeOvertime } from './overtime';
import { shortfallPenalties, penaltyMinutes } from './penalty';

/*
 * Two shifts inside the rest window are ONE working day, and the whole point is
 * that everything downstream then treats it as one: the hours add up, they are
 * compared against that day's schedule once, and whatever comes out - overtime
 * or a shortfall - is a single item on the queue with the ordinary Accept and
 * Revoke behind it.
 *
 * Beirut is UTC+3. Schedule is 9h a day, grace 15m, rate $3.00/h.
 */
const RATE = [{ rate_cent: 300, effective_from: new Date('2020-01-01T00:00:00Z') }];
const NINE_HOURS = new Map([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 540]));
const b = (kind: 'IN' | 'OUT', wallClock: string): PunchLite => ({ kind, at: new Date(wallClock + '+03:00') });

const cover = (punches: PunchLite[]) =>
  computeCoverage({
    punches,
    shiftMinByWeekday: NINE_HOURS,
    overridesByDate: new Map(),
    rateCentAt: () => 300,
  });

const overtime = (days: ReturnType<typeof cover>) =>
  computeOvertime({ coverage: days, rateChanges: RATE, graceMin: 15, decisionsByDate: new Map() });

const penalties = (days: ReturnType<typeof cover>) =>
  shortfallPenalties({
    coverage: days,
    rateChanges: RATE,
    graceMin: 15,
    currentShiftDate: '2099-01-01',
    waivers: new Map(),
  });

describe('two shifts merged into one working day', () => {
  // 08:00-14:00 (6h), home two hours, 16:00-21:00 (5h). Eleven hours worked
  // against nine owed.
  const OVER: PunchLite[] = [
    b('IN', '2026-09-14T08:00'), b('OUT', '2026-09-14T14:00'),
    b('IN', '2026-09-14T16:00'), b('OUT', '2026-09-14T21:00'),
  ];

  it('is one day, and the hours are the sum of both halves', () => {
    const days = cover(OVER);
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe('2026-09-14');
    expect(days[0]!.workedMin).toBe(360 + 300);
    expect(days[0]!.requiredMin).toBe(540); // asked once, not once per half
    expect(days[0]!.deltaMin).toBe(120);
  });

  it('raises ONE overtime item, for the whole day', () => {
    const items = overtime(cover(OVER));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ date: '2026-09-14', overtimeMin: 120 });
    // 2h at $3.00. This is the figure Accept and Revoke act on.
    expect(items[0]!.amount_cent).toBe(600);
  });

  it('and no penalty, because the day as a whole is not short', () => {
    // Judged separately, the 6h half would be 3h short of a 9h day and docked.
    expect(penalties(cover(OVER))).toEqual([]);
  });

  it('prices both halves into the day, so the penalty ceiling covers both', () => {
    const day = cover(OVER)[0]!;
    expect(day.intervals).toHaveLength(2);
    expect(day.grossCent).toBe(Math.floor((360 * 300) / 60) + Math.floor((300 * 300) / 60));
  });
});

describe('the same day when it falls short', () => {
  // 08:00-11:00 (3h), home two hours, 13:00-16:00 (3h). Six against nine.
  const SHORT: PunchLite[] = [
    b('IN', '2026-09-14T08:00'), b('OUT', '2026-09-14T11:00'),
    b('IN', '2026-09-14T13:00'), b('OUT', '2026-09-14T16:00'),
  ];

  it('docks once, on the summed shortfall', () => {
    const items = penalties(cover(SHORT));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ date: '2026-09-14', shortfallMin: 180 });
    // 3h short doubles to 6h, which is the whole day, so the ceiling takes it
    // to exactly what the day earned - never more.
    expect(items[0]!.penaltyMin).toBe(penaltyMinutes(180, 360, 15));
    expect(items[0]!.amount_cent).toBe(cover(SHORT)[0]!.grossCent);
  });

  it('raises no overtime', () => {
    expect(overtime(cover(SHORT))).toEqual([]);
  });
});

describe('the grace is applied to the day, not to each half', () => {
  it('forgives ten minutes short across two shifts', () => {
    // 4h25m + 4h25m = 8h50m, ten minutes short of nine hours: inside the grace.
    // Judged half by half, each would be 4h35m short and docked twice.
    const nearlyNine: PunchLite[] = [
      b('IN', '2026-09-14T08:00'), b('OUT', '2026-09-14T12:25'),
      b('IN', '2026-09-14T14:00'), b('OUT', '2026-09-14T18:25'),
    ];
    const days = cover(nearlyNine);
    expect(days[0]!.deltaMin).toBe(-10);
    expect(penalties(days)).toEqual([]);
    expect(overtime(days)).toEqual([]);
  });
});

describe('past the rest window they are two days, judged separately', () => {
  it('gives each its own schedule and its own item', () => {
    // The same eleven hours, but five hours apart instead of two.
    const split: PunchLite[] = [
      b('IN', '2026-09-14T08:00'), b('OUT', '2026-09-14T14:00'),
      b('IN', '2026-09-14T19:00'), b('OUT', '2026-09-15T00:00'),
    ];
    const days = cover(split);
    expect(days.map((d) => d.date)).toEqual(['2026-09-14', '2026-09-15']);
    // Nine owed on EACH, so both are short and both are docked - which is the
    // trade the rest rule makes, and why the check-in that opens the second day
    // sends a message.
    expect(days.map((d) => d.deltaMin)).toEqual([-180, -240]);
    expect(penalties(days).map((p) => p.date)).toEqual(['2026-09-14', '2026-09-15']);
  });
});
