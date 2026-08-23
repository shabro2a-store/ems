import { describe, it, expect } from 'vitest';
import { computeOvertime, sumRevokedOvertimeCent } from './overtime';
import type { DayCoverage } from './coverage';

const RATE = [{ rate_cent: 60_000, effective_from: new Date('2020-01-01T00:00:00Z') }];

function day(over: Partial<DayCoverage>): DayCoverage {
  return {
    date: '2026-08-17',
    requiredMin: 480,
    workedMin: 480,
    deltaMin: 0,
    closed: true,
    lastPunchAt: new Date('2026-08-17T14:00:00Z'),
    grossCent: 0, // overtime never reads it; penalties are what the gross bounds
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
      coverage: [day({ deltaMin: 90 })],
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
      coverage: [day({ requiredMin: 480, workedMin: 780, deltaMin: 300 })],
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
      coverage: [day({ requiredMin: 480, workedMin: 600, deltaMin: 120 })],
      rateChanges: rate,
      graceMin: 15,
      decisionsByDate: ruledAt120,
    });
    expect(asRuled[0]!.amount_cent).toBe(400);
    expect(sumRevokedOvertimeCent(asRuled)).toBe(400);

    const afterMoreWork = computeOvertime({
      coverage: [day({ requiredMin: 480, workedMin: 780, deltaMin: 300 })],
      rateChanges: rate,
      graceMin: 15,
      decisionsByDate: ruledAt120,
    });
    expect(afterMoreWork[0]!.amount_cent).toBe(1000);
    expect(sumRevokedOvertimeCent(afterMoreWork)).toBe(0);
    expect(afterMoreWork[0]!.decision).toBeNull();
  });
});
