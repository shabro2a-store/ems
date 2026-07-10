import { describe, it, expect } from 'vitest';
import {
  verifyWithinGeofence,
  haversineDistanceM,
  type GeofenceBranch,
} from './geofence';

const HAMRA: GeofenceBranch = {
  id: 'b1',
  lat: 33.8962,
  lng: 35.4827,
  gps_radius_m: 50,
  gps_accuracy_max_m: 100,
};

function withBranches(...bs: GeofenceBranch[]): GeofenceBranch[] {
  return bs;
}

describe('haversineDistanceM', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistanceM(33.8962, 35.4827, 33.8962, 35.4827)).toBeCloseTo(0, 5);
  });

  it('matches known reference: ~111.2km per 1 degree of latitude', () => {
    const d = haversineDistanceM(0, 0, 1, 0);
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_500);
  });

  it('Hamra to Achrafieh is roughly 3km', () => {
    const d = haversineDistanceM(33.8962, 35.4827, 33.8895, 35.5163);
    expect(d).toBeGreaterThan(2_500);
    expect(d).toBeLessThan(4_000);
  });
});

describe('verifyWithinGeofence', () => {
  it('returns ok when inside the radius with good accuracy', () => {
    const r = verifyWithinGeofence(33.8962, 35.4827, withBranches(HAMRA), 10);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nearest.id).toBe('b1');
      expect(r.distance).toBeLessThan(1);
    }
  });

  it('boundary: distance exactly == radius passes (strict less-than on the outer bound)', () => {
    const r = verifyWithinGeofence(33.8962 + 50 / 111_320, 35.4827, withBranches(HAMRA), 0);
    expect(r.ok).toBe(true);
  });

  it('just outside the radius returns TOO_FAR', () => {
    const r = verifyWithinGeofence(33.8962 + 0.001, 35.4827, withBranches(HAMRA), 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('TOO_FAR');
      expect(r.nearest?.id).toBe('b1');
    }
  });

  it('accuracy tolerance widens the effective radius', () => {
    const r = verifyWithinGeofence(33.8962 + 0.0004, 35.4827, withBranches(HAMRA), 30);
    expect(r.ok).toBe(true);
  });

  it('accuracy tolerance does NOT cover distance well past radius + accuracy', () => {
    const r = verifyWithinGeofence(33.8962 + 0.01, 35.4827, withBranches(HAMRA), 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TOO_FAR');
  });

  it('returns LOW_GPS_ACCURACY when accuracy > gps_accuracy_max_m', () => {
    const r = verifyWithinGeofence(33.8962, 35.4827, withBranches(HAMRA), 200);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('LOW_GPS_ACCURACY');
  });

  it('always rejects if any branches list has only inactive branches', () => {
    const r = verifyWithinGeofence(
      33.8962,
      35.4827,
      withBranches({ ...HAMRA, is_active: false }),
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TOO_FAR');
  });

  it('pickes the nearest among multiple active branches', () => {
    const achrafieh: GeofenceBranch = {
      id: 'b2',
      lat: 33.8895,
      lng: 35.5163,
      gps_radius_m: 50,
      gps_accuracy_max_m: 100,
    };
    const r = verifyWithinGeofence(33.8962, 35.4827, withBranches(achrafieh, HAMRA), 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nearest.id).toBe('b1');
  });
});
