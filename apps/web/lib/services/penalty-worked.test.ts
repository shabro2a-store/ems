import { describe, it, expect } from 'vitest';
import { shortfallPenalties, penaltyMinutes } from './penalty';
import type { DayCoverage } from './coverage';

/*
 * The penalty rule, checked against worked examples rather than by re-deriving
 * the formula. Rate is $3.00/h (300 cents) throughout, grace is the branch
 * default of 15 minutes, and every day here is closed and in the past.
 *
 *   shortfall <= grace  -> nothing
 *   otherwise           -> min(2 x shortfall, workedMin), priced at the day's
 *                          rate and then clamped to what the day actually earned
 */

const RATE = [{ rate_cent: 300, effective_from: new Date('2020-01-01T00:00:00Z') }];
const GRACE = 15;

function day(over: Partial<DayCoverage> & { date: string; requiredMin: number; workedMin: number }): DayCoverage {
  const grossCent = Math.floor((over.workedMin * 300) / 60);
  return {
    closed: true,
    deltaMin: over.workedMin - over.requiredMin,
    lastPunchAt: new Date(`${over.date}T18:00:00Z`),
    grossCent,
    intervals: [{ minutes: over.workedMin, rateCent: 300 }],
    ...over,
  } as DayCoverage;
}

function penalties(days: DayCoverage[]) {
  return shortfallPenalties({
    coverage: days,
    rateChanges: RATE,
    graceMin: GRACE,
    currentShiftDate: '2099-01-01', // nothing here is today
    waivers: new Map(),
  });
}

describe('penaltyMinutes — the rule itself', () => {
  it('forgives a shortfall inside the grace, and nothing beyond it', () => {
    expect(penaltyMinutes(15, 480, GRACE)).toBe(0); // exactly the grace
    expect(penaltyMinutes(16, 480, GRACE)).toBe(32); // one minute past it: 2x the WHOLE shortfall
  });

  it('doubles the shortfall, not the part past the grace', () => {
    expect(penaltyMinutes(30, 480, GRACE)).toBe(60);
    expect(penaltyMinutes(60, 480, GRACE)).toBe(120);
  });

  it('never docks more than the day was worth', () => {
    // Four hours worked of a nine-hour day: 5h short, doubling says 10h, which
    // is more than the day earned. The ceiling is the day itself.
    expect(penaltyMinutes(300, 240, GRACE)).toBe(240);
  });

  it('costs almost nothing to somebody who barely turned up', () => {
    // In and straight back out. Doubling a full day's shortfall would be
    // enormous; the ceiling makes it ~0, which is the same answer a no-show
    // gets - a notice, not an automatic fine.
    expect(penaltyMinutes(480, 1, GRACE)).toBe(1);
  });
});

describe('a month of realistic days', () => {
  it('produces the amounts the owner would expect', () => {
    const items = penalties([
      day({ date: '2026-09-01', requiredMin: 480, workedMin: 480 }), // exact
      day({ date: '2026-09-02', requiredMin: 480, workedMin: 540 }), // an hour over
      day({ date: '2026-09-03', requiredMin: 480, workedMin: 470 }), // 10m short, inside grace
      day({ date: '2026-09-04', requiredMin: 480, workedMin: 450 }), // 30m short
      day({ date: '2026-09-05', requiredMin: 480, workedMin: 420 }), // 1h short
      day({ date: '2026-09-06', requiredMin: 480, workedMin: 240 }), // 4h short, half a day
    ]);

    // Only the three real shortfalls are charged.
    expect(items.map((i) => i.date)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);

    // 30m short -> 60m docked -> $3.00
    expect(items[0]).toMatchObject({ shortfallMin: 30, penaltyMin: 60, amount_cent: 300 });
    // 1h short -> 2h docked -> $6.00
    expect(items[1]).toMatchObject({ shortfallMin: 60, penaltyMin: 120, amount_cent: 600 });
    // 4h short of 8h, worked 4h -> doubling says 8h but the day only earned 4h,
    // so the whole day is taken and no more. $12.00 earned, $12.00 docked.
    expect(items[2]).toMatchObject({ shortfallMin: 240, penaltyMin: 240, amount_cent: 1200 });
    expect(items[2]!.amount_cent).toBe(day({ date: '2026-09-06', requiredMin: 480, workedMin: 240 }).grossCent);
  });

  it('never takes more from a day than the day earned', () => {
    // The property that makes the whole thing safe: whatever the shortfall, the
    // worst outcome is a day that pays nothing - never a day that costs money.
    for (const workedMin of [0, 1, 30, 120, 240, 479, 480]) {
      const d = day({ date: '2026-09-10', requiredMin: 480, workedMin });
      const [item] = penalties([d]);
      if (!item) continue;
      expect(item.amount_cent).toBeLessThanOrEqual(d.grossCent);
    }
  });
});

describe('days that must not be judged', () => {
  it('leaves a shift still open alone', () => {
    // Hours are unknowable until the missing punch is corrected.
    const open = { ...day({ date: '2026-09-11', requiredMin: 480, workedMin: 60 }), closed: false };
    expect(penalties([open])).toHaveLength(0);
  });

  it('leaves today alone until it is over', () => {
    // Split shifts: clocking out after the morning would otherwise raise a full
    // day's shortfall at lunchtime, which then vanished when they came back.
    const today = day({ date: '2026-09-12', requiredMin: 480, workedMin: 200 });
    expect(
      shortfallPenalties({
        coverage: [today],
        rateChanges: RATE,
        graceMin: GRACE,
        currentShiftDate: '2026-09-12',
        waivers: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('charges the same day once it is over', () => {
    expect(penalties([day({ date: '2026-09-12', requiredMin: 480, workedMin: 200 })])).toHaveLength(1);
  });

  it('says nothing about a day that owed nothing', () => {
    // A day off, or a weekday with no scheduled hours. Coming in to help can
    // only ever put the day ahead, never behind.
    expect(penalties([day({ date: '2026-09-13', requiredMin: 0, workedMin: 0 })])).toHaveLength(0);
    expect(penalties([day({ date: '2026-09-14', requiredMin: 0, workedMin: 180 })])).toHaveLength(0);
  });
});

describe('a waived day', () => {
  it('is reported as forgiven and stops the money', () => {
    const d = day({ date: '2026-09-15', requiredMin: 480, workedMin: 420 });
    const [item] = shortfallPenalties({
      coverage: [d],
      rateChanges: RATE,
      graceMin: GRACE,
      currentShiftDate: '2099-01-01',
      waivers: new Map([['2026-09-15|SHORTFALL', { penalty_min: 120 }]]),
    });
    expect(item).toMatchObject({ waived: true, waiverStale: false, amount_cent: 600 });
  });

  it('is flagged for review when the day has changed under the ruling', () => {
    // The owner forgave 2 hours; a corrected punch has since made it something
    // else. Still forgiven — the money does not move — but he is asked again.
    const d = day({ date: '2026-09-16', requiredMin: 480, workedMin: 300 });
    const [item] = shortfallPenalties({
      coverage: [d],
      rateChanges: RATE,
      graceMin: GRACE,
      currentShiftDate: '2099-01-01',
      waivers: new Map([['2026-09-16|SHORTFALL', { penalty_min: 120 }]]),
    });
    expect(item).toMatchObject({ waived: true, waiverStale: true });
  });
});
