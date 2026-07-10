export interface GeofenceBranch {
  id: string;
  lat: number;
  lng: number;
  gps_radius_m: number;
  gps_accuracy_max_m: number;
  is_active?: boolean;
}

export type GeofenceReason = 'TOO_FAR' | 'LOW_GPS_ACCURACY';

export interface GeofenceOk {
  ok: true;
  nearest: GeofenceBranch;
  distance: number;
}

export interface GeofenceFail {
  ok: false;
  reason: GeofenceReason;
  distance?: number;
  nearest?: GeofenceBranch;
}

export type GeofenceResult = GeofenceOk | GeofenceFail;

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = toRadians(lat2 - lat1);
  const dLambda = toRadians(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function verifyWithinGeofence(
  lat: number,
  lng: number,
  branches: GeofenceBranch[],
  accuracy: number,
): GeofenceResult {
  const activeBranches = branches.filter((b) => b.is_active !== false);
  if (activeBranches.length === 0) {
    return { ok: false, reason: 'TOO_FAR' };
  }

  const sorted = activeBranches
    .map((b) => ({
      branch: b,
      distance: haversineDistanceM(lat, lng, b.lat, b.lng),
    }))
    .sort((a, b) => a.distance - b.distance);

  const nearest = sorted[0]!;

  if (accuracy > nearest.branch.gps_accuracy_max_m) {
    return {
      ok: false,
      reason: 'LOW_GPS_ACCURACY',
      nearest: nearest.branch,
      distance: nearest.distance,
    };
  }

  if (nearest.distance >= nearest.branch.gps_radius_m + accuracy) {
    return {
      ok: false,
      reason: 'TOO_FAR',
      nearest: nearest.branch,
      distance: nearest.distance,
    };
  }

  return {
    ok: true,
    nearest: nearest.branch,
    distance: nearest.distance,
  };
}
