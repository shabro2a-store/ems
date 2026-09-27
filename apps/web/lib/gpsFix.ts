export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Date.now() when the phone gave it. */
  at: number;
}

// Long enough to take the receipt photo after "Get GPS", far too short to carry
// a position from the branch to anywhere else.
export const FIX_MAX_AGE_MS = 2 * 60_000;

export function fixIsFresh(fix: GpsFix, now: number = Date.now()): boolean {
  const age = now - fix.at;
  return age >= 0 && age <= FIX_MAX_AGE_MS;
}

export const STALE_FIX_MESSAGE = 'Your location is out of date. Tap "Get GPS" again.';
