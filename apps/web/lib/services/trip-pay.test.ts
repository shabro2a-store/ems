import { describe, it, expect } from 'vitest';
import { tripPay, computePayoutFromRows, type TripRow } from './payout';

/*
 * A driver's second earnings line: per completed trip, on top of the hour.
 * Beirut is UTC+3 through all of these dates.
 */
const b = (iso: string) => new Date(iso + '+03:00');
const trip = (outAt: string, backAt: string | null): TripRow => ({ out_at: b(outAt), back_at: backAt ? b(backAt) : null });
const RATE_150 = [{ rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') }];

describe('tripPay', () => {
  it('counts completed trips and prices each at the rate', () => {
    const trips = [
      trip('2026-09-14T10:00', '2026-09-14T10:40'),
      trip('2026-09-14T13:00', '2026-09-14T13:25'),
      trip('2026-09-15T09:00', '2026-09-15T09:50'),
    ];
    expect(tripPay(trips, RATE_150, '2026-09')).toEqual({ count: 3, cent: 450 });
  });

  it('does not pay a trip still out', () => {
    // No BACK yet: the delivery is not finished and nothing is owed for it. The
    // trip-close sweep writes a BACK for a forgotten one, and it pays then.
    const trips = [trip('2026-09-14T10:00', '2026-09-14T10:40'), trip('2026-09-14T18:00', null)];
    expect(tripPay(trips, RATE_150, '2026-09')).toEqual({ count: 1, cent: 150 });
  });

  it('files a trip in the month it went OUT, by Beirut date', () => {
    // 00:30 on 1 October is October's trip, whatever shift it happened inside.
    // Trips are events, not spans; the day it happened is the day it belongs to.
    const trips = [trip('2026-09-30T23:30', '2026-10-01T00:10'), trip('2026-10-01T00:30', '2026-10-01T01:00')];
    expect(tripPay(trips, RATE_150, '2026-09')).toEqual({ count: 1, cent: 150 });
    expect(tripPay(trips, RATE_150, '2026-10')).toEqual({ count: 1, cent: 150 });
  });

  it('prices each trip at the rate in force when it went out', () => {
    // Raised from $1.50 to $2.00 on the 15th. The trip on the 14th keeps its
    // price; a mid-month change reprices nothing that already happened - the
    // same rule an hour follows.
    const rates = [
      { rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') },
      { rate_cent: 200, effective_from: b('2026-09-15T00:00') },
    ];
    const trips = [trip('2026-09-14T10:00', '2026-09-14T10:40'), trip('2026-09-16T10:00', '2026-09-16T10:40')];
    expect(tripPay(trips, rates, '2026-09')).toEqual({ count: 2, cent: 350 });
  });

  it('pays nothing with no rate history, whatever was driven', () => {
    // A driver the owner has not set a per-trip rate for. The trips are counted
    // - the owner can see them - but they are worth zero until he prices them.
    expect(tripPay([trip('2026-09-14T10:00', '2026-09-14T10:40')], [], '2026-09')).toEqual({ count: 1, cent: 0 });
  });
});

describe('inside the payout', () => {
  const punches = [
    { id: 'p1', user_id: 'd', kind: 'IN' as const, at: b('2026-09-14T08:00') },
    { id: 'p2', user_id: 'd', kind: 'OUT' as const, at: b('2026-09-14T16:00') },
  ];
  const HOURLY = [{ user_id: 'd', rate_cent: 300, effective_from: new Date('2020-01-01T00:00:00Z') }];
  const base = {
    userId: 'd',
    punches,
    rateChanges: HOURLY,
    adjustments: [],
    approvedAdvances: [],
    month: '2026-09',
  };

  it('sits beside gross, not inside it', () => {
    const r = computePayoutFromRows({
      ...base,
      trips: [trip('2026-09-14T10:00', '2026-09-14T10:40'), trip('2026-09-14T13:00', '2026-09-14T13:25')],
      tripRateChanges: [{ rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') }],
    });
    // Eight hours at $3.00 is gross, untouched by the trips.
    expect(r.grossCent).toBe(2400);
    expect(r.tripsCount).toBe(2);
    expect(r.tripsCent).toBe(300);
    // And the net carries both.
    expect(r.netCent).toBe(2400 + 300);
  });

  it('is zero for anyone who is not a driver, and changes nothing else', () => {
    const before = computePayoutFromRows(base);
    expect(before.tripsCount).toBe(0);
    expect(before.tripsCent).toBe(0);
    expect(before.netCent).toBe(2400);
  });

  it('is not eaten by a penalty', () => {
    // The penalty ceiling is the day's HOURS pay; trips are a second thing
    // earned and a shortfall in the hours does not reach into them.
    const r = computePayoutFromRows({
      ...base,
      penaltiesCent: 2400, // the whole day's hours docked
      trips: [trip('2026-09-14T10:00', '2026-09-14T10:40')],
      tripRateChanges: [{ rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') }],
    });
    expect(r.netCent).toBe(150);
  });
});
