import { describe, it, expect } from 'vitest';
import {
  computeOvertime,
  overtimeRateOn,
  OVERTIME_RATE_FROM,
  sumOvertimePremiumCent,
  sumRevokedOvertimeCent,
} from './overtime';
import { centsForLastMinutes, type DayCoverage } from './coverage';
import { computePayoutFromRows } from './payout';

/*
 * The owner's rule, 2026-10-01: overtime is paid at each person's own
 * overtime rate, not their hourly rate.
 *  - Overtime means exactly what the owner sees on a notice: a day that ran
 *    past its hours by more than the grace, the whole overrun; a day with no
 *    hours required (a day off) is all overtime.
 *  - The rate is dated by working day, and nothing before 2026-10-01 changes.
 *  - No overtime rate set means the hourly rate, as before.
 *  - A pending or accepted day is paid at it; Revoke takes back what the
 *    overtime minutes were paid - at the overtime rate.
 */
const HOURLY = 200; // $2.00/h
const OT = 300; // $3.00/h
const RATES = [{ rate_cent: HOURLY, effective_from: new Date('2026-01-01T00:00:00Z') }];
const date = (d: string) => new Date(`${d}T00:00:00.000Z`);

function day(over: Partial<DayCoverage>): DayCoverage {
  const workedMin = over.workedMin ?? 570;
  const intervals = over.intervals ?? [{ minutes: workedMin, rateCent: HOURLY }];
  return {
    date: '2026-10-05',
    requiredMin: 480,
    workedMin,
    deltaMin: workedMin - (over.requiredMin ?? 480),
    closed: true,
    lastPunchAt: new Date('2026-10-05T15:00:00Z'),
    grossCent: centsForLastMinutes(intervals, workedMin),
    intervals,
    ...over,
  };
}

const otFromOct1 = (d: string) => overtimeRateOn([{ rate_cent: OT, effective_from: date('2026-10-01') }], d);

describe('overtimeRateOn', () => {
  it('starts on 1 October 2026', () => {
    expect(OVERTIME_RATE_FROM).toBe('2026-10-01');
  });

  it('is the latest rate dated on or before the working day', () => {
    const rows = [
      { rate_cent: 300, effective_from: date('2026-10-01') },
      { rate_cent: 350, effective_from: date('2026-10-10') },
    ];
    expect(overtimeRateOn(rows, '2026-10-01')).toBe(300);
    expect(overtimeRateOn(rows, '2026-10-09')).toBe(300);
    expect(overtimeRateOn(rows, '2026-10-10')).toBe(350);
  });

  it('is null - the hourly rate - with no rate set, after one is cleared, or before it starts', () => {
    expect(overtimeRateOn([], '2026-10-05')).toBeNull();
    const rows = [
      { rate_cent: 300, effective_from: date('2026-10-01') },
      { rate_cent: null, effective_from: date('2026-10-12') },
    ];
    expect(overtimeRateOn(rows, '2026-10-12')).toBeNull();
    expect(overtimeRateOn(rows, '2026-10-05')).toBe(300);
  });

  it('never prices a day before 1 October 2026, whatever the rows say', () => {
    expect(overtimeRateOn([{ rate_cent: 300, effective_from: date('2026-09-01') }], '2026-09-30')).toBeNull();
  });
});

describe('overtime at the overtime rate', () => {
  it('pays the whole overrun past the grace at the overtime rate', () => {
    const [item] = computeOvertime({
      coverage: [day({ workedMin: 570 })], // 90 min over an 8h day
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: otFromOct1,
    });
    expect(item).toMatchObject({ overtimeMin: 90, rate_cent: OT, amount_cent: 450, premium_cent: 150 });
  });

  it('leaves a run inside the grace at the hourly rate, with no notice', () => {
    const items = computeOvertime({
      coverage: [day({ workedMin: 490 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: otFromOct1,
    });
    expect(items).toEqual([]);
  });

  it('pays every minute of a day off at the overtime rate', () => {
    const [item] = computeOvertime({
      coverage: [day({ requiredMin: 0, workedMin: 240 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: otFromOct1,
    });
    expect(item).toMatchObject({ overtimeMin: 240, amount_cent: 1200, premium_cent: 400 });
  });

  it('pays the hourly rate when no overtime rate is set, as before', () => {
    const [item] = computeOvertime({
      coverage: [day({ workedMin: 570 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: () => null,
    });
    expect(item).toMatchObject({ rate_cent: HOURLY, amount_cent: 300, premium_cent: 0 });
  });

  it('changes nothing on a September day', () => {
    const [item] = computeOvertime({
      coverage: [day({ date: '2026-09-30', workedMin: 570 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: (d) => overtimeRateOn([{ rate_cent: OT, effective_from: date('2026-09-01') }], d),
    });
    expect(item).toMatchObject({ amount_cent: 300, premium_cent: 0 });
  });

  it('adds the premium to gross; Revoke takes back the overtime pay and leaves the required hours', () => {
    const pending = computeOvertime({
      coverage: [day({ workedMin: 570 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map(),
      overtimeRateOn: otFromOct1,
    });
    const revoked = computeOvertime({
      coverage: [day({ workedMin: 570 })],
      rateChanges: RATES,
      graceMin: 15,
      decisionsByDate: new Map([['2026-10-05', { decision: 'REVOKED' as const, overtime_min: 90 }]]),
      overtimeRateOn: otFromOct1,
    });
    const punches = [
      { id: 'i', user_id: 'u', kind: 'IN' as const, at: new Date('2026-10-05T05:30:00Z') },
      { id: 'o', user_id: 'u', kind: 'OUT' as const, at: new Date('2026-10-05T15:00:00Z') },
    ];
    const pay = (items: typeof pending) =>
      computePayoutFromRows({
        userId: 'u',
        punches,
        rateChanges: [{ user_id: 'u', rate_cent: HOURLY, effective_from: new Date('2026-01-01T00:00:00Z') }],
        adjustments: [],
        approvedAdvances: [],
        overtimeDeductionCent: sumRevokedOvertimeCent(items),
        overtimePremiumCent: sumOvertimePremiumCent(items),
        month: '2026-10',
      });

    const p = pay(pending);
    // 480 min at $2 = 1600, plus 90 min at $3 = 450.
    expect(p.grossCent).toBe(1600 + 450);
    expect(p.overtimePremiumCent).toBe(150);
    expect(p.netCent).toBe(2050);

    const r = pay(revoked);
    expect(r.overtimeDeductionCent).toBe(450);
    expect(r.netCent).toBe(1600);
  });
});
