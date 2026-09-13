import { describe, it, expect } from 'vitest';
import { tripPay, computePayoutFromRows, workingDayOfTrip, tripDayResolver, tripsOnCurrentWorkingDay, type TripRow } from './payout';
import type { PunchLite } from './coverage';

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

  it('falls back to the day it went out on, when handed no punches', () => {
    // The default resolver, for a caller with nothing else in hand. Payroll
    // never uses it - see below - but it has to answer something sane.
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

  it('is inside gross, and is not added to net a second time', () => {
    // Gross is what the month earned; for a driver that is the hours and the
    // trips together, the same way blocked credit already lives inside it.
    const r = computePayoutFromRows({
      ...base,
      trips: [trip('2026-09-14T10:00', '2026-09-14T10:40'), trip('2026-09-14T13:00', '2026-09-14T13:25')],
      tripRateChanges: [{ rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') }],
    });
    expect(r.tripsCount).toBe(2);
    expect(r.tripsCent).toBe(300); // the memo
    expect(r.grossCent).toBe(2400 + 300); // eight hours at $3.00, plus the trips
    expect(r.netCent).toBe(2700); // gross, once
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

/*
 * A trip belongs to the working day of the SHIFT it happened in - the same
 * rest rule that files the punches - so a driver's hours and deliveries can
 * never land on different days, or in different months. This is the reason
 * trips do not simply take the date they went out on.
 */
describe('which working day a trip belongs to', () => {
  const punch = (kind: 'IN' | 'OUT', iso: string): PunchLite => ({ kind, at: b(iso) });
  const rate = [{ rate_cent: 150, effective_from: new Date('2020-01-01T00:00:00Z') }];

  it('follows the shift across midnight, into the previous month', () => {
    // Night shift 30 Sep 22:00 -> 1 Oct 06:00. A trip at 00:30 happened inside
    // it, so it is 30 September's - and September's money.
    const punches = [punch('IN', '2026-09-30T22:00'), punch('OUT', '2026-10-01T06:00')];
    const dayOf = tripDayResolver(punches, 0);
    expect(dayOf(b('2026-10-01T00:30'))).toBe('2026-09-30');

    const trips = [trip('2026-10-01T00:30', '2026-10-01T01:00')];
    expect(tripPay(trips, rate, '2026-09', dayOf)).toEqual({ count: 1, cent: 150 });
    expect(tripPay(trips, rate, '2026-10', dayOf)).toEqual({ count: 0, cent: 0 });
  });

  it('stays with the day through a break between two chunks', () => {
    // 08:00-12:00, out for two hours, 14:00-18:00: one working day. A trip at
    // 13:00, in the gap, is still that day's - the driver had not gone home.
    const punches = [
      punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00'),
      punch('IN', '2026-09-14T14:00'), punch('OUT', '2026-09-14T18:00'),
    ];
    const dayOf = tripDayResolver(punches, 0);
    expect(dayOf(b('2026-09-14T13:00'))).toBe('2026-09-14');
    expect(dayOf(b('2026-09-14T15:00'))).toBe('2026-09-14');
  });

  it('takes the label the collision rule gave the shift, not the calendar', () => {
    // Two working days both starting on the 14th; the second was pushed to the
    // 15th. A trip inside the second shift goes with it.
    const punches = [
      punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00'),
      punch('IN', '2026-09-14T20:00'), punch('OUT', '2026-09-15T02:00'), // 8h rest: a new day
    ];
    const dayOf = tripDayResolver(punches, 0);
    expect(dayOf(b('2026-09-14T09:00'))).toBe('2026-09-14');
    expect(dayOf(b('2026-09-14T22:00'))).toBe('2026-09-15');
  });

  it('falls back to the calendar once the driver has gone home', () => {
    // Clocked out at 12:00 and not back for six hours. A trip at 15:00 has no
    // shift around it - the guard refuses this now, but history holds a few -
    // so it takes the day it happened on rather than a shift that had ended.
    const punches = [punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00')];
    const labels = ['2026-09-14', '2026-09-14'];
    expect(workingDayOfTrip(b('2026-09-14T15:00'), punches, labels)).toBe('2026-09-14');
    expect(workingDayOfTrip(b('2026-09-15T15:00'), punches, labels)).toBe('2026-09-15');
  });

  it('keeps hours and trips in the same month inside the payout', () => {
    // The whole point, end to end: the night shift is September's hours, so
    // its 00:30 trip is September's trip, and October sees neither.
    const punches = [
      { id: 'p1', user_id: 'd', kind: 'IN' as const, at: b('2026-09-30T22:00') },
      { id: 'p2', user_id: 'd', kind: 'OUT' as const, at: b('2026-10-01T06:00') },
    ];
    const args = {
      userId: 'd',
      punches,
      rateChanges: [{ user_id: 'd', rate_cent: 300, effective_from: new Date('2020-01-01T00:00:00Z') }],
      adjustments: [],
      approvedAdvances: [],
      trips: [trip('2026-10-01T00:30', '2026-10-01T01:00')],
      tripRateChanges: rate,
    };
    const sep = computePayoutFromRows({ ...args, month: '2026-09' });
    const oct = computePayoutFromRows({ ...args, month: '2026-10' });
    expect(sep.hours).toBe(8);
    expect(sep.tripsCount).toBe(1);
    expect(sep.grossCent).toBe(2400 + 150);
    expect(oct.hours).toBe(0);
    expect(oct.tripsCount).toBe(0);
    expect(oct.grossCent).toBe(0);
  });
});

/*
 * "Trips today" on the caller's board and the admin dashboard.
 *
 * Where the shift belongs, its trips belong. If a driver's return continued the
 * same working day the count keeps going; if it opened a new day the count
 * starts again and everything before it was the previous day's. One rule, the
 * same one payroll files trips by - there used to be three.
 */
describe('trips on the working day the driver is on', () => {
  const punch = (kind: 'IN' | 'OUT', iso: string): PunchLite => ({ kind, at: b(iso) });
  const count = (punches: PunchLite[], trips: TripRow[], now: string) =>
    tripsOnCurrentWorkingDay({ punches, trips, now: b(now) }).count;

  it('keeps counting when a break was not rest', () => {
    // 08:00-12:00 with two trips, home two hours, back at 14:00 and out again.
    // Old rule reset this to zero at 14:00 - "trips since this clock-in". Same
    // working day, so the third trip makes three.
    const punches = [
      punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00'),
      punch('IN', '2026-09-14T14:00'),
    ];
    const trips = [
      trip('2026-09-14T09:00', '2026-09-14T09:30'),
      trip('2026-09-14T10:30', '2026-09-14T11:00'),
      trip('2026-09-14T15:00', '2026-09-14T15:30'),
    ];
    expect(count(punches, trips, '2026-09-14T16:00')).toBe(3);
  });

  it('starts again when the return opened a new working day', () => {
    // Same two morning trips, home SIX hours, back at 18:00. That is rest, so
    // 18:00 opens a new day - and it is pushed to the 15th because the 14th is
    // taken. The morning's trips are the previous day's; today's count is one.
    const punches = [
      punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00'),
      punch('IN', '2026-09-14T18:00'),
    ];
    const trips = [
      trip('2026-09-14T09:00', '2026-09-14T09:30'),
      trip('2026-09-14T10:30', '2026-09-14T11:00'),
      trip('2026-09-14T19:00', '2026-09-14T19:30'),
    ];
    expect(count(punches, trips, '2026-09-14T20:00')).toBe(1);
  });

  it('does not cut a night shift in half at midnight', () => {
    // 22:00 to 06:00 with a trip either side of midnight. The calendar rule gave
    // two "todays" of one trip each; it is one working day of two.
    const punches = [punch('IN', '2026-09-30T22:00')];
    const trips = [trip('2026-09-30T23:00', '2026-09-30T23:30'), trip('2026-10-01T01:00', '2026-10-01T01:30')];
    expect(count(punches, trips, '2026-10-01T02:00')).toBe(2);
  });

  it('is zero once they have gone home', () => {
    // No day in progress five hours after clocking out, so nothing is "today".
    const punches = [punch('IN', '2026-09-14T08:00'), punch('OUT', '2026-09-14T12:00')];
    const trips = [trip('2026-09-14T09:00', '2026-09-14T09:30')];
    expect(count(punches, trips, '2026-09-14T17:00')).toBe(0);
    // But inside the rest window the day is still theirs and so are its trips.
    expect(count(punches, trips, '2026-09-14T13:00')).toBe(1);
  });

  it('counts a trip still out, once it has gone out', () => {
    // The board wants to know they went - it shows them as unavailable. Payroll
    // waits for the BACK; this does not.
    const punches = [punch('IN', '2026-09-14T08:00')];
    const trips = [trip('2026-09-14T09:00', null)];
    expect(count(punches, trips, '2026-09-14T09:30')).toBe(1);
  });
});
