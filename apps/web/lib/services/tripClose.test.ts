import { describe, it, expect } from 'vitest';
import { MAX_OPEN_TRIP_MIN, systemBackAt, abandonedTripClose } from './tripClose';
import { MAX_OPEN_SESSION_MIN } from './coverage';

const OUT = new Date('2026-07-10T18:00:00Z');
const at = (min: number) => new Date(OUT.getTime() + min * 60_000);

describe('systemBackAt', () => {
  it('credits the branch its own delivery time and nothing more', () => {
    expect(systemBackAt(OUT, 30)).toEqual(at(30));
    expect(systemBackAt(OUT, 90)).toEqual(at(90));
  });

  it('never writes a return at the instant of the departure', () => {
    // Unreachable through the admin UI (tripThresholdMin is validated at
    // min(1)) and kept anyway: a zero-minute delivery in the feed is a lie
    // that costs nothing to prevent.
    expect(systemBackAt(OUT, 0)).toEqual(at(1));
    expect(systemBackAt(OUT, -5)).toEqual(at(1));
  });
});

describe('abandonedTripClose', () => {
  it('leaves a delivery that could still be running alone', () => {
    expect(abandonedTripClose({ outAt: OUT, now: at(30), thresholdMin: 30 })).toBeNull();
    // Four hours is driverStale's "phone dead or stranded" alert. The owner is
    // told there; nothing is closed there.
    expect(abandonedTripClose({ outAt: OUT, now: at(4 * 60), thresholdMin: 30 })).toBeNull();
    expect(abandonedTripClose({ outAt: OUT, now: at(MAX_OPEN_TRIP_MIN), thresholdMin: 30 })).toBeNull();
  });

  it('closes one minute past the threshold', () => {
    const r = abandonedTripClose({ outAt: OUT, now: at(MAX_OPEN_TRIP_MIN + 1), thresholdMin: 30 });
    expect(r).not.toBeNull();
    expect(r!.closeAt).toEqual(at(30));
    expect(r!.thresholdMin).toBe(30);
  });

  it('closes at the same instant however late it is asked', () => {
    // The sweep and the driver's punch path both call this and must agree; the
    // sweep may run three days after the punch path would have.
    const a = abandonedTripClose({ outAt: OUT, now: at(7 * 60), thresholdMin: 30 })!;
    const b = abandonedTripClose({ outAt: OUT, now: at(72 * 60), thresholdMin: 30 })!;
    expect(a.closeAt).toEqual(b.closeAt);
  });

  it('sits above driverStale and below the punch threshold', () => {
    // Above 4h: notify first, close later - the same order as missedCheckout
    // before autoCloseAbandoned.
    expect(MAX_OPEN_TRIP_MIN).toBeGreaterThan(4 * 60);
    // Below 30h: a shift can legitimately run 24h, a delivery cannot. The
    // branch threshold that dates the close caps at 240 min for that reason.
    expect(MAX_OPEN_TRIP_MIN).toBeLessThan(MAX_OPEN_SESSION_MIN);
    expect(MAX_OPEN_TRIP_MIN).toBeGreaterThan(240);
  });
});
