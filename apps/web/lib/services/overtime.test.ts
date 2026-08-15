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
      decisionsByDate: new Map([['2026-08-17', 'REVOKED']]),
    });
    expect(items[0]!.decision).toBe('REVOKED');
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
        ['2026-08-17', 'REVOKED'],
        ['2026-08-19', 'ACCEPTED'],
      ]),
    });
    // 08-18 is pending (no entry) and 08-19 is ACCEPTED - neither is REVOKED, so
    // only 08-17's amount may count. This pins REVOKED as the sole trigger: a
    // decision !== null check would wrongly pull in the ACCEPTED day too.
    expect(sumRevokedOvertimeCent(items)).toBe(60_000);
  });
});
