import { describe, it, expect } from 'vitest';
import { computeCoverage, type PunchLite } from './coverage';

const utc = (iso: string) => new Date(iso);
// 2026-08-17 is a Monday in Beirut (UTC+3 in August).
const MON = 1;

function punches(...pairs: Array<[string, 'IN' | 'OUT']>): PunchLite[] {
  return pairs.map(([iso, kind]) => ({ kind, at: utc(iso) }));
}

describe('computeCoverage', () => {
  it('attributes an overnight shift wholly to the check-in day', () => {
    // 21:00 Mon Beirut = 18:00Z Mon; 07:00 Tue Beirut = 04:00Z Tue.
    const out = computeCoverage({
      punches: punches(['2026-08-17T18:00:00Z', 'IN'], ['2026-08-18T04:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-08-17');
    expect(out[0]!.workedMin).toBe(600);
    expect(out[0]!.requiredMin).toBe(480);
    expect(out[0]!.deltaMin).toBe(120);
    expect(out[0]!.closed).toBe(true);
  });

  it('sums multiple in/out pairs on the same day', () => {
    const out = computeCoverage({
      punches: punches(
        ['2026-08-17T05:00:00Z', 'IN'],
        ['2026-08-17T08:00:00Z', 'OUT'],
        ['2026-08-17T09:00:00Z', 'IN'],
        ['2026-08-17T12:00:00Z', 'OUT'],
      ),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out[0]!.workedMin).toBe(360);
    expect(out[0]!.deltaMin).toBe(-120);
  });

  it('leaves a day unclosed when a check-in has no checkout', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out[0]!.closed).toBe(false);
    expect(out[0]!.workedMin).toBe(0);
  });

  it('lets an HOURS_CHANGE override beat the weekday value', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T09:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map([['2026-08-17', { kind: 'HOURS_CHANGE', shift_min: 240 }]]),
    });
    expect(out[0]!.requiredMin).toBe(240);
    expect(out[0]!.deltaMin).toBe(0);
  });

  it('treats a DAY_OFF override as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map([['2026-08-17', { kind: 'DAY_OFF', shift_min: null }]]),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('treats an unscheduled weekday as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map(),
      overridesByDate: new Map(),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('ignores a checkout with no preceding check-in', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(0);
  });
});
