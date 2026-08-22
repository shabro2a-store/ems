import { describe, it, expect } from 'vitest';
import { beirutDateSeries, lookbackMonths, mergeNotices, type DatedNotice } from './noticeWindow';

interface Notice extends DatedNotice {
  amount_cent: number;
}

function notice(user_id: string, username: string, date: string, amount_cent = 100): Notice {
  return { user_id, username, date, amount_cent };
}

describe('lookbackMonths', () => {
  it('stays inside one month when the window does not cross a boundary', () => {
    expect(lookbackMonths('2026-08-09', '2026-08-16')).toEqual(['2026-08']);
  });

  it('spans both months on the 1st, where the whole lookback is in the previous month', () => {
    // The bug: only the current month was ever queried, so on the 1st every
    // unresolved item from the 25th to the 31st disappeared. For overtime that
    // is not a hidden notice but a silent auto-approval, because a day with no
    // decision is already paid.
    expect(lookbackMonths('2026-07-25', '2026-08-01')).toEqual(['2026-07', '2026-08']);
  });

  it('spans a December-to-January boundary', () => {
    expect(lookbackMonths('2025-12-28', '2026-01-03')).toEqual(['2025-12', '2026-01']);
  });

  it('falls back to the current month if since is somehow later than today', () => {
    expect(lookbackMonths('2026-09-01', '2026-08-16')).toEqual(['2026-08']);
  });
});

describe('mergeNotices', () => {
  it('keeps items from every month in the window, newest day first', () => {
    const merged = mergeNotices([
      [notice('u1', 'ali', '2026-07-30'), notice('u2', 'bassam', '2026-07-31')],
      [notice('u1', 'ali', '2026-08-01')],
    ]);
    expect(merged.map((n) => `${n.username}:${n.date}`)).toEqual([
      'ali:2026-08-01',
      'bassam:2026-07-31',
      'ali:2026-07-30',
    ]);
  });

  it('sorts same-day notices by username', () => {
    const merged = mergeNotices([[notice('u2', 'bassam', '2026-08-01'), notice('u1', 'ali', '2026-08-01')]]);
    expect(merged.map((n) => n.username)).toEqual(['ali', 'bassam']);
  });

  it('keeps one entry per user-day, preferring the later month window', () => {
    // A Beirut day straddles two UTC month windows, so the 1st can be computed
    // from either side. The later window holds the larger part of the day.
    const merged = mergeNotices([
      [notice('u1', 'ali', '2026-08-01', 500)],
      [notice('u1', 'ali', '2026-08-01', 4000)],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.amount_cent).toBe(4000);
  });

  it('returns an empty list when no month produced anything', () => {
    expect(mergeNotices<Notice>([[], []])).toEqual([]);
  });
});

describe('beirutDateSeries', () => {
  it('lists the last N Beirut dates, oldest first, ending on the given day', () => {
    expect(beirutDateSeries('2026-08-23', 4)).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ]);
    expect(beirutDateSeries('2026-08-23', 1)).toEqual(['2026-08-23']);
  });

  it('crosses a month boundary', () => {
    expect(beirutDateSeries('2026-03-02', 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('neither repeats nor skips a day across either DST change', () => {
    // The old instant walk (now - i*24h) listed 2026-03-28 twice and never
    // listed 2026-03-29, and the duplicate collapsed in the caller's Map so one
    // bar rendered zero.
    const spring = beirutDateSeries('2026-03-30', 7);
    expect(spring).toEqual([
      '2026-03-24',
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);

    const autumn = beirutDateSeries('2026-10-26', 4);
    expect(autumn).toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);

    for (const series of [spring, autumn]) {
      expect(new Set(series).size).toBe(series.length);
    }
  });
});
