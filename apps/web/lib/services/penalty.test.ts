import { describe, it, expect } from 'vitest';
import { penaltyMinutes, shortfallPenalties } from './penalty';
import type { DayCoverage } from './coverage';

const RATE = [{ rate_cent: 60_000, effective_from: new Date('2020-01-01T00:00:00Z') }];
// The owner's own numbers: $2.00/h against an 8-hour day.
const REAL_RATE = [{ rate_cent: 200, effective_from: new Date('2020-01-01T00:00:00Z') }];
const SHIFT_MIN = 480;
const GRACE = 15;

// deltaMin is derived, never passed: a fixture that could disagree with its own
// workedMin would let a ceiling assertion pass against a day that never existed.
function day(over: { workedMin: number; requiredMin?: number; date?: string; closed?: boolean }): DayCoverage {
  const requiredMin = over.requiredMin ?? SHIFT_MIN;
  return {
    date: over.date ?? '2026-08-17',
    requiredMin,
    workedMin: over.workedMin,
    deltaMin: over.workedMin - requiredMin,
    closed: over.closed ?? true,
    lastPunchAt: new Date('2026-08-17T14:00:00Z'),
  };
}

function amountFor(workedMin: number): number {
  const items = shortfallPenalties({
    coverage: [day({ workedMin })],
    rateChanges: REAL_RATE,
    graceMin: GRACE,
    waivedKeys: new Set(),
  });
  return items[0]?.amount_cent ?? 0;
}

describe('penaltyMinutes', () => {
  it('forgives a shortfall exactly at the grace', () => {
    expect(penaltyMinutes(15, 465, 15)).toBe(0);
  });

  it('forgives a shortfall inside the grace', () => {
    expect(penaltyMinutes(1, 479, 15)).toBe(0);
  });

  it('doubles the whole shortfall one minute past the grace, not just the part above it', () => {
    // The grace is a threshold, not forgiveness - exactly like overtime. If it
    // were forgiveness this would be 2, and the jump at the boundary is the
    // owner's deliberate deterrent.
    expect(penaltyMinutes(16, 464, 15)).toBe(32);
  });

  it('doubles the shortfall', () => {
    expect(penaltyMinutes(30, 450, 15)).toBe(60);
    expect(penaltyMinutes(60, 420, 15)).toBe(120);
  });

  it('ceilings at the minutes actually worked', () => {
    // 4h short having worked 4h: doubling says 8h, which would eat into other
    // days' pay. The worst a day can cost is the day itself.
    expect(penaltyMinutes(240, 240, 15)).toBe(240);
  });

  it('docks about nothing for a day that worked about nothing', () => {
    // Punch in and straight out. A no-show is a notice, not an automatic
    // penalty, and this keeps it that way rather than docking a full day.
    expect(penaltyMinutes(480, 0, 15)).toBe(0);
    expect(penaltyMinutes(479, 1, 15)).toBe(1);
  });

  it('takes the grace from its caller rather than assuming 15', () => {
    expect(penaltyMinutes(20, 460, 30)).toBe(0);
    expect(penaltyMinutes(20, 460, 15)).toBe(40);
    expect(penaltyMinutes(1, 479, 0)).toBe(2);
  });
});

describe('shortfallPenalties', () => {
  it('prices the owner\'s table at $2.00/h against an 8h day', () => {
    expect(amountFor(479)).toBe(0); //   1 min short - inside the grace
    expect(amountFor(465)).toBe(0); //  15 min short - exactly at the grace
    expect(amountFor(464)).toBe(106); // 16 min short -> 32 min docked, $1.06
    expect(amountFor(450)).toBe(200); // 30 min short -> 60 min docked, $2.00
    expect(amountFor(420)).toBe(400); //  1h short    -> 2h docked,     $4.00
    expect(amountFor(240)).toBe(800); //  4h short having worked 4h -> 4h, $8.00
    expect(amountFor(0)).toBe(0); //      worked nothing -> nothing
  });

  it('never docks more than the day earned', () => {
    // The whole point of the ceiling: 4h at $2.00 grosses $8.00, and the
    // penalty is exactly that, so the day nets zero and no other day is touched.
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 240 })],
      rateChanges: REAL_RATE,
      graceMin: GRACE,
      waivedKeys: new Set(),
    });
    const grossCent = Math.floor((240 * 200) / 60);
    expect(items[0]!.penaltyMin).toBe(240);
    expect(items[0]!.amount_cent).toBe(grossCent);
    expect(items[0]!.amount_cent).toBeLessThanOrEqual(grossCent);
  });

  it('reports the shortfall and the minutes docked separately', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360 })],
      rateChanges: RATE,
      graceMin: GRACE,
      waivedKeys: new Set(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('SHORTFALL');
    expect(items[0]!.shortfallMin).toBe(120);
    expect(items[0]!.penaltyMin).toBe(240);
    expect(items[0]!.rate_cent).toBe(60_000);
    expect(items[0]!.amount_cent).toBe(240_000);
  });

  it('raises nothing for a day that worked about nothing', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 0 })],
        rateChanges: RATE,
        graceMin: GRACE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('ignores a day that met its hours', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: SHIFT_MIN })],
        rateChanges: RATE,
        graceMin: GRACE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('ignores overtime', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 600 })],
        rateChanges: RATE,
        graceMin: GRACE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('does not judge an unclosed day', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 0, closed: false })],
        rateChanges: RATE,
        graceMin: GRACE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('marks a waived day', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360 })],
      rateChanges: RATE,
      graceMin: GRACE,
      waivedKeys: new Set(['2026-08-17|SHORTFALL']),
    });
    expect(items[0]!.waived).toBe(true);
  });
});
