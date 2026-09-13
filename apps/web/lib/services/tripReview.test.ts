import { describe, it, expect } from 'vitest';
import { REVIEW_WINDOW_MIN, reviewDeadline, dayReviewState, tripLocked, tripsByDriverDay } from './tripReview';
import type { PunchLite } from './coverage';

/*
 * The owner reviews a driver's receipts one working day at a time, beside the
 * cash count for that shift. Beirut is UTC+3 through all of these dates.
 */
const b = (iso: string) => new Date(iso + '+03:00');
const trip = (outAt: string, over: Partial<{ reviewed_at: Date | null; denied_at: Date | null }> = {}) => ({
  out_at: b(outAt),
  reviewed_at: over.reviewed_at ?? null,
  denied_at: over.denied_at ?? null,
});

describe('reviewDeadline', () => {
  it('is 48 hours after the LAST trip of the day went out', () => {
    expect(REVIEW_WINDOW_MIN).toBe(48 * 60);
    const trips = [trip('2026-09-14T10:00'), trip('2026-09-14T16:30'), trip('2026-09-14T13:00')];
    expect(reviewDeadline(trips)).toEqual(b('2026-09-16T16:30'));
  });

  it('is null for a day with no trips', () => {
    expect(reviewDeadline([])).toBeNull();
  });
});

describe('dayReviewState', () => {
  const trips = [trip('2026-09-14T10:00'), trip('2026-09-14T16:30')];

  it('is open while the window is running and nobody has confirmed', () => {
    expect(dayReviewState({ date: '2026-09-14', trips, now: b('2026-09-15T09:00') })).toBe('open');
  });

  it('expires 48 hours after the last trip: everything is paid and nothing can change', () => {
    expect(dayReviewState({ date: '2026-09-14', trips, now: b('2026-09-16T16:29') })).toBe('open');
    expect(dayReviewState({ date: '2026-09-14', trips, now: b('2026-09-16T16:30') })).toBe('expired');
  });

  it('is confirmed once every trip of the day has been reviewed', () => {
    const reviewed = trips.map((t) => ({ ...t, reviewed_at: b('2026-09-14T20:00') }));
    expect(dayReviewState({ date: '2026-09-14', trips: reviewed, now: b('2026-09-14T21:00') })).toBe('confirmed');
    // Still confirmed long after - confirmation is not undone by the clock.
    expect(dayReviewState({ date: '2026-09-14', trips: reviewed, now: b('2026-09-20T21:00') })).toBe('confirmed');
  });

  it('reopens for a trip made after the shift was confirmed', () => {
    // The owner confirmed at 20:00 with the driver still on shift; a trip at
    // 21:00 has not been looked at. The day needs another look, but the two
    // trips already confirmed stay locked - see tripLocked.
    const mixed = [...trips.map((t) => ({ ...t, reviewed_at: b('2026-09-14T20:00') })), trip('2026-09-14T21:00')];
    expect(dayReviewState({ date: '2026-09-14', trips: mixed, now: b('2026-09-14T22:00') })).toBe('open');
  });

  it('is locked by the month closing, even inside the 48 hours', () => {
    // A trip on the 30th at 20:00 has its 48 hours run to the 2nd at 20:00, but
    // September's payroll closes at 00:15 on the 2nd. The month wins: a ruling
    // after that would change a figure that is being paid.
    const lastDay = [trip('2026-09-30T20:00')];
    expect(dayReviewState({ date: '2026-09-30', trips: lastDay, now: b('2026-10-02T00:10') })).toBe('open');
    expect(dayReviewState({ date: '2026-09-30', trips: lastDay, now: b('2026-10-02T00:20') })).toBe('month_closed');
  });

  it('has nothing to say about a day with no trips', () => {
    expect(dayReviewState({ date: '2026-09-14', trips: [], now: b('2026-09-15T09:00') })).toBe('empty');
  });
});

describe('tripLocked', () => {
  it('a trip is locked by its own confirmation, or by the day being past review', () => {
    const fresh = trip('2026-09-14T10:00');
    const confirmed = trip('2026-09-14T10:00', { reviewed_at: b('2026-09-14T20:00') });
    expect(tripLocked(fresh, 'open')).toBe(false);
    expect(tripLocked(confirmed, 'open')).toBe(true);
    expect(tripLocked(fresh, 'expired')).toBe(true);
    expect(tripLocked(fresh, 'month_closed')).toBe(true);
    expect(tripLocked(fresh, 'confirmed')).toBe(true);
  });
});

describe('tripsByDriverDay', () => {
  // The review page's grouping: every driver's trips, filed under the working
  // day of the SHIFT each happened in - the same rule payroll files them by -
  // so the day the owner confirms is the day the driver is paid for.
  const punch = (kind: 'IN' | 'OUT', iso: string): PunchLite => ({ kind, at: b(iso) });
  const t = (driver_id: string, outAt: string) => ({ id: `${driver_id}-${outAt}`, driver_id, out_at: b(outAt) });

  it('files each trip by its driver and the working day of its shift', () => {
    const punches = new Map<string, PunchLite[]>([
      // Night shift: 22:00 on the 14th to 06:00 on the 15th is the 14th's day.
      ['night', [punch('IN', '2026-09-14T22:00'), punch('OUT', '2026-09-15T06:00')]],
      ['day', [punch('IN', '2026-09-15T08:00'), punch('OUT', '2026-09-15T16:00')]],
    ]);
    const trips = [t('night', '2026-09-14T23:00'), t('night', '2026-09-15T00:30'), t('day', '2026-09-15T10:00')];
    const grouped = tripsByDriverDay({ trips, punchesByDriver: punches, dayStartHourOf: () => 0 });
    expect([...grouped.get('night')!.keys()]).toEqual(['2026-09-14']);
    expect(grouped.get('night')!.get('2026-09-14')!.map((x) => x.id)).toEqual(['night-2026-09-14T23:00', 'night-2026-09-15T00:30']);
    expect([...grouped.get('day')!.keys()]).toEqual(['2026-09-15']);
  });

  it('falls back to the calendar day for a driver with no punches in hand', () => {
    const grouped = tripsByDriverDay({ trips: [t('x', '2026-09-15T00:30')], punchesByDriver: new Map(), dayStartHourOf: () => 0 });
    expect([...grouped.get('x')!.keys()]).toEqual(['2026-09-15']);
  });
});
