import { describe, it, expect } from 'vitest';
import { hasHistory, type UserHistory } from './userDelete';

const NONE: UserHistory = {
  punches: 0,
  trips: 0,
  advances: 0,
  adjustments: 0,
  penaltyWaivers: 0,
  penaltyAcks: 0,
  overtimeDecisions: 0,
  blockedCreditDecisions: 0,
  blockedPunches: 0,
  driverCalls: 0,
};

describe('hasHistory', () => {
  it('lets a mistake account go', () => {
    // The case the button exists for: created with the wrong name, or a test
    // account from the beta. Nothing of theirs is a record of anything.
    expect(hasHistory(NONE)).toBe(false);
  });

  it('protects anyone who ever clocked in', () => {
    expect(hasHistory({ ...NONE, punches: 1 })).toBe(true);
  });

  it('protects every kind of money and attendance record on its own', () => {
    // Each one alone is enough. A person can have been paid an advance, or had
    // a penalty waived, without ever having a punch left on file.
    for (const key of Object.keys(NONE) as Array<keyof UserHistory>) {
      expect(hasHistory({ ...NONE, [key]: 1 })).toBe(true);
    }
  });

  it('counts a caller who only ever rang drivers', () => {
    // A caller never punches. Their rings are still part of those trips.
    expect(hasHistory({ ...NONE, driverCalls: 3 })).toBe(true);
  });
});
