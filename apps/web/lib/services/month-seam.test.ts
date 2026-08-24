import { describe, it, expect } from 'vitest';
import { computePayoutFromRows, monthRangeUtc } from './payout';

/*
 * The month boundary, for the people who work across it.
 *
 * A shift belongs to the Beirut day it checked IN - the rule coverage, the
 * penalty engine and the auto-close all follow. Payroll did not follow it: it
 * asked Postgres for the punches whose timestamps fell inside the UTC month and
 * paired whatever came back, so a 21:00-07:00 shift starting on the last night
 * of the month handed January an arrival with no checkout and February a
 * checkout with no arrival. `pairHours` drops both. The night paid ZERO, in
 * both months, every month, for every overnight worker.
 *
 * These tests pair through the real function with the real month window, so
 * they fail again the moment either side of that stops agreeing.
 */

const RATE = [{ user_id: 'u1', rate_cent: 300, effective_from: new Date('2020-01-01T00:00:00Z') }];
const PAIR_LOOKAROUND_MS = 2 * 86_400_000;

function payoutForMonth(month: string, punches: Array<{ kind: 'IN' | 'OUT'; at: Date }>) {
  const { start, end } = monthRangeUtc(month);
  // Exactly the window payoutForUser sends to Postgres.
  const from = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const to = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  return computePayoutFromRows({
    userId: 'u1',
    punches: punches
      .filter((p) => p.at >= from && p.at < to)
      .map((p, i) => ({ id: `p${i}`, user_id: 'u1', kind: p.kind, at: p.at })),
    rateChanges: RATE,
    adjustments: [],
    approvedAdvances: [],
    month,
  });
}

describe('a night shift across the month boundary', () => {
  // Beirut is UTC+2 in winter: in 31 Jan 21:00, out 1 Feb 07:00, ten hours.
  const NIGHT = [
    { kind: 'IN' as const, at: new Date('2026-01-31T19:00:00Z') },
    { kind: 'OUT' as const, at: new Date('2026-02-01T05:00:00Z') },
  ];

  it('is paid in full, in the month it started', () => {
    const jan = payoutForMonth('2026-01', NIGHT);
    const feb = payoutForMonth('2026-02', NIGHT);

    expect(jan.hours).toBe(10);
    expect(jan.grossCent).toBe(3000);
    // And not a second time in February - double pay is the other way to get
    // this wrong.
    expect(feb.hours).toBe(0);
    expect(feb.grossCent).toBe(0);
  });

  it('is paid once, never twice, whichever month is asked for', () => {
    const jan = payoutForMonth('2026-01', NIGHT);
    const feb = payoutForMonth('2026-02', NIGHT);
    expect(jan.grossCent + feb.grossCent).toBe(3000);
  });

  it('the same night in summer, when Beirut is UTC+3', () => {
    // 30 Jun 21:00 -> 1 Jul 07:00 Beirut = 30 Jun 18:00 -> 1 Jul 04:00 UTC.
    const summer = [
      { kind: 'IN' as const, at: new Date('2026-06-30T18:00:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-07-01T04:00:00Z') },
    ];
    expect(payoutForMonth('2026-06', summer).grossCent).toBe(3000);
    expect(payoutForMonth('2026-07', summer).grossCent).toBe(0);
  });

  it('a shift starting just after midnight on the 1st belongs to the new month', () => {
    // 1 Feb 00:30 Beirut is 31 Jan 22:30 UTC - inside JANUARY's UTC window, so
    // this used to be paid in January purely because of the two-hour offset.
    const earlyHours = [
      { kind: 'IN' as const, at: new Date('2026-01-31T22:30:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-02-01T04:30:00Z') },
    ];
    expect(payoutForMonth('2026-01', earlyHours).grossCent).toBe(0);
    expect(payoutForMonth('2026-02', earlyHours).grossCent).toBe(1800);
  });

  it('leaves an ordinary mid-month day exactly as it was', () => {
    const day = [
      { kind: 'IN' as const, at: new Date('2026-01-15T06:00:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-01-15T14:00:00Z') },
    ];
    expect(payoutForMonth('2026-01', day).hours).toBe(8);
    expect(payoutForMonth('2026-02', day).hours).toBe(0);
  });

  it('pays nothing for a shift still open at the month end, until it closes', () => {
    // Clocked in on the 31st and still on shift. Nothing is owed for hours that
    // have not been worked yet; the whole night lands in January the moment the
    // checkout is written, wherever in February that happens.
    const open = [{ kind: 'IN' as const, at: new Date('2026-01-31T19:00:00Z') }];
    expect(payoutForMonth('2026-01', open).grossCent).toBe(0);

    const closed = [...open, { kind: 'OUT' as const, at: new Date('2026-02-01T05:00:00Z') }];
    expect(payoutForMonth('2026-01', closed).grossCent).toBe(3000);
  });

  it('handles a run of consecutive nights over the boundary', () => {
    // 30th, 31st and 1st, each 21:00-07:00. Two nights are January's, one
    // February's, and the seam must not swallow the middle one.
    const nights = [
      { kind: 'IN' as const, at: new Date('2026-01-30T19:00:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-01-31T05:00:00Z') },
      { kind: 'IN' as const, at: new Date('2026-01-31T19:00:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-02-01T05:00:00Z') },
      { kind: 'IN' as const, at: new Date('2026-02-01T19:00:00Z') },
      { kind: 'OUT' as const, at: new Date('2026-02-02T05:00:00Z') },
    ];
    expect(payoutForMonth('2026-01', nights).hours).toBe(20);
    expect(payoutForMonth('2026-02', nights).hours).toBe(10);
  });
});
