import { describe, it, expect } from 'vitest';
import { penaltyHours, computePenalties } from './penalty';

// Schedule times are Beirut wall-clock. Beirut is UTC+3 in July (DST), so a
// 08:00 Beirut start = 05:00 UTC, and a 16:00 end = 13:00 UTC.
const RATE = [{ rate_cent: 600, effective_from: new Date('2026-01-01T00:00:00Z') }];
const SCHED = new Map([[3, { start_time: '08:00', end_time: '16:00' }]]); // Wed=3
// 2026-07-15 is a Wednesday.

type Args = Parameters<typeof computePenalties>[0];
function base(o: Partial<Args> = {}): Args {
  return {
    punches: o.punches ?? [],
    schedulesByWeekday: o.schedulesByWeekday ?? SCHED,
    overridesByDate: o.overridesByDate ?? new Map(),
    rateChanges: o.rateChanges ?? RATE,
    waivedKeys: o.waivedKeys ?? new Set<string>(),
    now: o.now ?? new Date('2026-07-20T00:00:00Z'), // a later day, so the 15th is "past"
  };
}

describe('penaltyHours', () => {
  it('is a 15-min grace then 1h per block, capped at 4', () => {
    expect(penaltyHours(0)).toBe(0);
    expect(penaltyHours(14)).toBe(0);
    expect(penaltyHours(15)).toBe(1);
    expect(penaltyHours(29)).toBe(1);
    expect(penaltyHours(30)).toBe(2);
    expect(penaltyHours(45)).toBe(3);
    expect(penaltyHours(60)).toBe(4);
    expect(penaltyHours(120)).toBe(4); // capped
  });
});

describe('computePenalties', () => {
  it('docks 1h for arriving 20 min late', () => {
    const items = computePenalties(
      base({
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T05:20:00Z') }, // 08:20 Beirut = 20 min late
          { kind: 'OUT', at: new Date('2026-07-15T13:00:00Z') }, // 16:00 Beirut, on time
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'LATE', hours: 1, amount_cent: 600 });
  });

  it('docks 2h for leaving 35 min early', () => {
    const items = computePenalties(
      base({
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T05:00:00Z') }, // on time
          { kind: 'OUT', at: new Date('2026-07-15T12:25:00Z') }, // 15:25 Beirut = 35 min early
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'EARLY_LEAVE', hours: 2, amount_cent: 1200 });
  });

  it('no penalty inside the 15-min grace on both ends', () => {
    const items = computePenalties(
      base({
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T05:10:00Z') }, // 10 min late
          { kind: 'OUT', at: new Date('2026-07-15T12:52:00Z') }, // 8 min early
        ],
      }),
    );
    expect(items).toHaveLength(0);
  });

  it('marks a penalty waived when a waiver exists', () => {
    const items = computePenalties(
      base({
        waivedKeys: new Set(['2026-07-15|LATE']),
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T06:00:00Z') }, // 1h late → 4h
          { kind: 'OUT', at: new Date('2026-07-15T13:00:00Z') },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'LATE', hours: 4, waived: true });
  });

  it('ignores a day the employee is off (override DAY_OFF)', () => {
    const items = computePenalties(
      base({
        overridesByDate: new Map([['2026-07-15', { kind: 'DAY_OFF', start_time: null, end_time: null }]]),
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T06:00:00Z') },
          { kind: 'OUT', at: new Date('2026-07-15T13:00:00Z') },
        ],
      }),
    );
    expect(items).toHaveLength(0);
  });

  it('does not compute early-leave while the shift is still ongoing', () => {
    const items = computePenalties(
      base({
        now: new Date('2026-07-15T11:30:00Z'), // 14:30 Beirut — before the 16:00 end
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T05:00:00Z') }, // on time
          { kind: 'OUT', at: new Date('2026-07-15T11:00:00Z') }, // stepped out, shift not over yet
        ],
      }),
    );
    expect(items).toHaveLength(0);
  });

  it('no penalty when punches exactly match the schedule (e.g. after an admin correction)', () => {
    const items = computePenalties(
      base({
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T05:00:00Z') }, // 08:00 Beirut sharp
          { kind: 'OUT', at: new Date('2026-07-15T13:00:00Z') }, // 16:00 Beirut sharp
        ],
      }),
    );
    expect(items).toHaveLength(0);
  });

  it('docks an overnight early-leave (20:00 → 05:00, left at 03:00 next day)', () => {
    // Tuesday 2026-07-14 overnight shift into Wednesday.
    const SCHED_ON = new Map([[2, { start_time: '20:00', end_time: '05:00' }]]); // Tue=2
    const items = computePenalties({
      schedulesByWeekday: SCHED_ON,
      overridesByDate: new Map(),
      rateChanges: RATE,
      waivedKeys: new Set<string>(),
      now: new Date('2026-07-15T12:00:00Z'), // well after the shift ended
      punches: [
        { kind: 'IN', at: new Date('2026-07-14T17:00:00Z') }, // 20:00 Beirut Tue, on time
        { kind: 'OUT', at: new Date('2026-07-15T00:00:00Z') }, // 03:00 Beirut Wed = 2h early
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'EARLY_LEAVE', date: '2026-07-14', hours: 4 });
  });

  it('skips a day with no schedule', () => {
    const items = computePenalties(
      base({
        schedulesByWeekday: new Map(), // nothing scheduled
        punches: [
          { kind: 'IN', at: new Date('2026-07-15T06:00:00Z') },
          { kind: 'OUT', at: new Date('2026-07-15T13:00:00Z') },
        ],
      }),
    );
    expect(items).toHaveLength(0);
  });
});
