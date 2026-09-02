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

// hasHistory no longer decides WHETHER somebody can be deleted - the owner's
// ruling is that they always can. It decides HOW: an account with nothing behind
// it is removed row and all, and one with records behind it is retired instead,
// which takes the login and the username and leaves the punches standing.
describe('hasHistory', () => {
  it('sends a mistake account down the hard-delete path', () => {
    // Created with the wrong name, or a test account from the beta. Nothing of
    // theirs is a record of anything, so nothing is lost by erasing the row.
    expect(hasHistory(NONE)).toBe(false);
  });

  it('sends anyone who ever clocked in down the retire path', () => {
    expect(hasHistory({ ...NONE, punches: 1 })).toBe(true);
  });

  it('treats every kind of money and attendance record as a record on its own', () => {
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
