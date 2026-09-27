import { describe, it, expect } from 'vitest';
import { fixIsFresh, FIX_MAX_AGE_MS } from './gpsFix';

/*
 * Security #3: the field screens kept the fix from "Get GPS" and used it for
 * every punch and trip after - get it at the branch, go home, and clock out on
 * time with the branch's position. A fix now serves one action, and only while
 * it is fresh.
 */
describe('a GPS fix', () => {
  const fix = { lat: 33.9, lng: 35.5, accuracy: 10, at: 1_000_000 };

  it('is good for a couple of minutes - long enough to take the receipt photo', () => {
    expect(FIX_MAX_AGE_MS).toBe(2 * 60_000);
    expect(fixIsFresh(fix, fix.at + 90_000)).toBe(true);
  });

  it('is stale after that', () => {
    expect(fixIsFresh(fix, fix.at + FIX_MAX_AGE_MS + 1)).toBe(false);
  });

  it('is not trusted from the future (a clock that moved)', () => {
    expect(fixIsFresh(fix, fix.at - 5_000)).toBe(false);
  });
});
