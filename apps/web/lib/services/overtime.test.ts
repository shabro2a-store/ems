import { describe, it, expect } from 'vitest';
import { computeOvertime, sumRevokedOvertimeCent } from './overtime';
import { centsForLastMinutes, computeCoverage, type DayCoverage, type PunchLite } from './coverage';
import { computePayoutFromRows, rateAt } from './payout';

const RATE_CENT = 60_000;
const RATE = [{ rate_cent: RATE_CENT, effective_from: new Date('2020-01-01T00:00:00Z') }];

// intervals and grossCent are derived from workedMin and one rate, so a fixture
// cannot claim a day that paid differently from the day it describes. Tests
// that care about two rates in one day build real punches instead.
function day(over: Partial<DayCoverage> & { rateCent?: number }): DayCoverage {
  const workedMin = over.workedMin ?? 480;
  const rateCent = over.rateCent ?? RATE_CENT;
  const intervals = [{ minutes: workedMin, rateCent }];
  return {
    date: '2026-08-17',
    requiredMin: 480,
    workedMin,
    deltaMin: 0,
    closed: true,
    lastPunchAt: new Date('2026-08-17T14:00:00Z'),
    grossCent: centsForLastMinutes(intervals, workedMin),
    intervals,
    ...over,
  };
}

describe('computeOvertime', () => {
  it('stays silent inside the grace', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 10 })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('stays silent exactly on the grace boundary', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 15 })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('reports starting one minute past the grace boundary', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 16 })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(1);
  });

  it('reports the whole overrun past the grace, not the excess over it', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 90 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(90);
    expect(items[0]!.amount_cent).toBe(90_000);
    expect(items[0]!.decision).toBeNull();
  });

  it('floors the amount after multiplying by a non-divisible rate, not before', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 90, rateCent: 1007 })],
      rateChanges: [{ rate_cent: 1007, effective_from: new Date('2020-01-01T00:00:00Z') }],
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.amount_cent).toBe(1510);
  });

  it('treats every minute of an unscheduled day as overtime', () => {
    const items = computeOvertime({
      coverage: [day({ requiredMin: 0, workedMin: 300, deltaMin: 300 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(300);
  });

  it('does not judge an unclosed day', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 300, closed: false })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('carries the recorded decision', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 60 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', { decision: 'REVOKED', overtime_min: 60 }]]),
    });
    expect(items[0]!.decision).toBe('REVOKED');
  });

  it('drops a decision once the day it was made against has grown', () => {
    // The owner ruled on 120 minutes. The day is now 300. The ruling covers the
    // day as it stood, so it no longer applies and the day reads as pending.
    const items = computeOvertime({
      coverage: [day({ requiredMin: 480, workedMin: 780, deltaMin: 300, rateCent: 200 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', { decision: 'REVOKED', overtime_min: 120 }]]),
    });
    expect(items[0]!.overtimeMin).toBe(300);
    expect(items[0]!.decision).toBeNull();
  });

  it('drops a decision that shrank as well as one that grew', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 60 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', { decision: 'ACCEPTED', overtime_min: 300 }]]),
    });
    expect(items[0]!.decision).toBeNull();
  });

  it('treats a decision with no recorded amount as stale', () => {
    // Any row written before the column existed. Null is read as stale rather
    // than backfilled, so it can only ever cost the owner, never the employee.
    const items = computeOvertime({
      coverage: [day({ deltaMin: 60 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', { decision: 'REVOKED', overtime_min: null }]]),
    });
    expect(items[0]!.decision).toBeNull();
  });
});

describe('sumRevokedOvertimeCent', () => {
  it('counts only revoked days', () => {
    const items = computeOvertime({
      coverage: [
        day({ date: '2026-08-17', deltaMin: 60 }),
        day({ date: '2026-08-18', deltaMin: 60 }),
        day({ date: '2026-08-19', deltaMin: 60 }),
      ],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([
        ['2026-08-17', { decision: 'REVOKED', overtime_min: 60 }],
        ['2026-08-19', { decision: 'ACCEPTED', overtime_min: 60 }],
      ]),
    });
    // 08-18 is pending (no entry) and 08-19 is ACCEPTED - neither is REVOKED, so
    // only 08-17's amount may count. This pins REVOKED as the sole trigger: a
    // decision !== null check would wrongly pull in the ACCEPTED day too.
    expect(sumRevokedOvertimeCent(items)).toBe(60_000);
  });

  it('deducts nothing for a revoked day whose overtime grew after the ruling', () => {
    // The reported defect, in cents. 15 min grace, an 8h shift at $2.00/h.
    // The owner saw 120 minutes over and revoked $4.00. Three more hours then
    // landed on the same day, making it 300 minutes over. The one decision row
    // is keyed by the day, so it used to expand to cover the new total and take
    // $10.00 - money the owner never agreed to.
    const rate = [{ rate_cent: 200, effective_from: new Date('2020-01-01T00:00:00Z') }];
    const ruledAt120 = new Map([['2026-08-17', { decision: 'REVOKED' as const, overtime_min: 120 }]]);

    const asRuled = computeOvertime({
      coverage: [day({ requiredMin: 480, workedMin: 600, deltaMin: 120, rateCent: 200 })],
      rateChanges: rate,
      graceMin: 15,
      decisionsByDate: ruledAt120,
    });
    expect(asRuled[0]!.amount_cent).toBe(400);
    expect(sumRevokedOvertimeCent(asRuled)).toBe(400);

    const afterMoreWork = computeOvertime({
      coverage: [day({ requiredMin: 480, workedMin: 780, deltaMin: 300, rateCent: 200 })],
      rateChanges: rate,
      graceMin: 15,
      decisionsByDate: ruledAt120,
    });
    expect(afterMoreWork[0]!.amount_cent).toBe(1000);
    expect(sumRevokedOvertimeCent(afterMoreWork)).toBe(0);
    expect(afterMoreWork[0]!.decision).toBeNull();
  });
});

// Beirut is UTC+3 in August. 2026-08-17 is a Monday.
function punches(...pairs: Array<[string, 'IN' | 'OUT']>): PunchLite[] {
  return pairs.map(([iso, kind]) => ({ kind, at: new Date(iso) }));
}

describe('revoking overtime takes back only what the excess was paid', () => {
  // $2.00 -> $3.00 at 14:00 Beirut, saved mid-shift as a RateChange always is.
  const RAISE = [
    { rate_cent: 200, effective_from: new Date('2020-01-01T00:00:00Z') },
    { rate_cent: 300, effective_from: new Date('2026-08-17T11:00:00Z') },
  ];
  // 08:00-12:00 Beirut at $2.00 (240 min, $8.00) and 15:00-19:00 at $3.00
  // (240 min, $12.00). 480 minutes worked, $20.00 gross.
  const ACROSS_THE_RAISE = punches(
    ['2026-08-17T05:00:00Z', 'IN'],
    ['2026-08-17T09:00:00Z', 'OUT'],
    ['2026-08-17T12:00:00Z', 'IN'],
    ['2026-08-17T16:00:00Z', 'OUT'],
  );

  function coverageFor(requiredMin: number) {
    return computeCoverage({
      punches: ACROSS_THE_RAISE,
      shiftMinByWeekday: new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, requiredMin] as const)),
      overridesByDate: new Map(),
      rateCentAt: (at) => rateAt(RAISE, at),
    });
  }

  function grossCent(): number {
    return computePayoutFromRows({
      userId: 'u1',
      punches: ACROSS_THE_RAISE.map((p, i) => ({ id: `p${i}`, user_id: 'u1', kind: p.kind, at: p.at })),
      rateChanges: RAISE.map((r) => ({ user_id: 'u1', ...r })),
      adjustments: [],
      approvedAdvances: [],
    }).grossCent;
  }

  it('leaves the employee their required hours after a mid-shift raise', () => {
    // Required 120 min, so 360 of the 480 worked are excess. Those 360 are the
    // last 360: all 240 of the $3.00 session plus 120 of the $2.00 one, which
    // payroll paid 1200 + 400 = 1600. Pricing the whole overrun at the closing
    // rate says floor(360 * 300 / 60) = 1800 and leaves them 200 for two hours
    // that were paid 400 - it eats into the hours they were owed.
    const gross = grossCent();
    expect(gross).toBe(2000);

    const items = computeOvertime({
      coverage: coverageFor(120),
      rateChanges: RAISE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(360);
    expect(Math.floor((360 * 300) / 60)).toBe(1800); // what one-rate pricing takes
    expect(items[0]!.amount_cent).toBe(1600);
    expect(gross - items[0]!.amount_cent).toBe(400); // the first 120 min, at $2.00
  });

  it('cannot take back more than the whole day on a day that required nothing', () => {
    // Every worked minute is overtime here, so the deduction is the day itself
    // and no more. One-rate pricing says floor(480 * 300 / 60) = 2400 against a
    // day that paid 2000, and reaches 400 into another day.
    const gross = grossCent();
    const items = computeOvertime({
      coverage: coverageFor(0),
      rateChanges: RAISE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(480);
    expect(Math.floor((480 * 300) / 60)).toBe(2400);
    expect(items[0]!.amount_cent).toBe(gross);
    expect(gross - items[0]!.amount_cent).toBe(0);
  });
});
