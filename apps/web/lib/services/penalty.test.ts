import { describe, it, expect } from 'vitest';
import { penaltyHours, shortfallPenalties } from './penalty';
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

describe('penaltyHours', () => {
  it('forgives a shortfall under 15 minutes', () => {
    expect(penaltyHours(14)).toBe(0);
  });
  it('docks one hour at 15 minutes', () => {
    expect(penaltyHours(15)).toBe(1);
  });
  it('caps at 4 hours', () => {
    expect(penaltyHours(600)).toBe(4);
  });
});

describe('shortfallPenalties', () => {
  it('penalises covering less than required', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360, deltaMin: -120 })],
      rateChanges: RATE,
      waivedKeys: new Set(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('SHORTFALL');
    expect(items[0]!.minutes).toBe(120);
    expect(items[0]!.hours).toBe(4);
    expect(items[0]!.amount_cent).toBe(240_000);
  });

  it('ignores a day that met its hours', () => {
    expect(
      shortfallPenalties({ coverage: [day({})], rateChanges: RATE, waivedKeys: new Set() }),
    ).toHaveLength(0);
  });

  it('ignores overtime', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 600, deltaMin: 120 })],
        rateChanges: RATE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('does not judge an unclosed day', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 0, deltaMin: -480, closed: false })],
        rateChanges: RATE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('marks a waived day', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360, deltaMin: -120 })],
      rateChanges: RATE,
      waivedKeys: new Set(['2026-08-17|SHORTFALL']),
    });
    expect(items[0]!.waived).toBe(true);
  });
});
