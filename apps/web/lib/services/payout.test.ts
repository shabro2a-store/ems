import { describe, it, expect } from 'vitest';
import { computePayoutFromRows, monthRangeUtc } from './payout';

function rc(rateCent: number, iso: string) {
  return { user_id: 'u', rate_cent: rateCent, effective_from: new Date(iso) };
}

function p(kind: 'IN' | 'OUT', iso: string, id = 'x') {
  return { id: `${id}-${iso}-${kind}`, user_id: 'u', kind, at: new Date(iso) };
}

describe('monthRangeUtc', () => {
  it('returns UTC start and exclusive end for 2026-07', () => {
    const { start, end } = monthRangeUtc('2026-07');
    expect(start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('throws on invalid format', () => {
    expect(() => monthRangeUtc('2026/07')).toThrow();
    expect(() => monthRangeUtc('2026-13')).toThrow();
    expect(() => monthRangeUtc('2026-00')).toThrow();
  });
});

describe('computePayoutFromRows', () => {
  it('pairs IN/OUT punches and computes hours + gross at single rate', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T16:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [],
    });
    expect(result.hours).toBe(8);
    expect(result.grossCent).toBe(1600);
    expect(result.adjustmentsCent).toBe(0);
    expect(result.advancesCent).toBe(0);
    expect(result.netCent).toBe(1600);
  });

  it('uses the rate effective at each punch (mid-month rate change)', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [
        p('IN', '2026-07-01T08:00:00Z'),
        p('OUT', '2026-07-01T16:00:00Z'),
        p('IN', '2026-07-15T08:00:00Z'),
        p('OUT', '2026-07-15T16:00:00Z'),
      ],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z'), rc(300, '2026-07-10T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [],
    });
    expect(result.hours).toBe(16);
    expect(result.grossCent).toBe(200 * 8 + 300 * 8);
  });

  it('applies BONUS as + and DEDUCTION as -', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T10:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [
        { user_id: 'u', kind: 'BONUS', amount_cent: 1000 },
        { user_id: 'u', kind: 'DEDUCTION', amount_cent: 300 },
      ],
      approvedAdvances: [],
    });
    expect(result.hours).toBe(2);
    expect(result.grossCent).toBe(400);
    expect(result.adjustmentsCent).toBe(700);
    expect(result.netCent).toBe(1100);
  });

  it('subtracts APPROVED advances from net', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T16:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [
        { user_id: 'u', amount_cent: 5000, status: 'APPROVED' },
      ],
    });
    expect(result.grossCent).toBe(1600);
    expect(result.advancesCent).toBe(5000);
    expect(result.netCent).toBe(1600 - 5000);
  });

  it('ignores PENDING advances', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T16:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [
        { user_id: 'u', amount_cent: 5000, status: 'PENDING' },
      ],
    });
    expect(result.advancesCent).toBe(0);
    expect(result.netCent).toBe(1600);
  });

  it('subtracts penalties from net', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T16:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [{ user_id: 'u', kind: 'BONUS', amount_cent: 1000 }],
      approvedAdvances: [],
      penaltiesCent: 400,
    });
    expect(result.grossCent).toBe(1600);
    expect(result.penaltiesCent).toBe(400);
    expect(result.netCent).toBe(1600 + 1000 - 400);
  });

  it('subtracts revoked overtime from net', () => {
    const res = computePayoutFromRows({
      userId: 'u1',
      punches: [],
      rateChanges: [],
      adjustments: [],
      approvedAdvances: [],
      overtimeDeductionCent: 5_000,
    });
    expect(res.overtimeDeductionCent).toBe(5_000);
    expect(res.netCent).toBe(-5_000);
  });

  it('deduction cancels exactly the overtime portion of a real gross', () => {
    const res = computePayoutFromRows({
      userId: 'u1',
      punches: [p('IN', '2026-07-01T08:00:00Z'), p('OUT', '2026-07-01T17:30:00Z')],
      rateChanges: [rc(60_000, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [],
      overtimeDeductionCent: 90_000,
    });
    // 570 worked minutes at 60_000 cent/hour is a 570_000 gross; deducting the
    // 90_000 (90-minute) overtime portion should leave exactly 8 paid hours.
    expect(res.grossCent).toBe(570_000);
    expect(res.netCent).toBe(480_000);
  });

  it('returns 0 hours when there are no punches', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [],
    });
    expect(result.hours).toBe(0);
    expect(result.grossCent).toBe(0);
    expect(result.netCent).toBe(0);
  });

  it('ignores unpaired IN (still clocked in)', () => {
    const result = computePayoutFromRows({
      userId: 'u',
      punches: [p('IN', '2026-07-01T08:00:00Z')],
      rateChanges: [rc(200, '2026-01-01T00:00:00Z')],
      adjustments: [],
      approvedAdvances: [],
    });
    expect(result.hours).toBe(0);
    expect(result.grossCent).toBe(0);
  });
});