import { describe, it, expect } from 'vitest';
import { scheduledToUtc } from 'time';
import { correctionProblem } from './correctionCheck';

/*
 * A correction could name any time at all. A typo that moved a checkout before
 * the check-in it closes made every reader pair the check-in with the NEXT
 * day's checkout - 32 hours paid for 16, and a day of overtime - and a time in
 * the future made the punch invisible to every "is this open" question.
 */
const now = scheduledToUtc('2026-10-14', '12:00');
const monIn = { kind: 'IN' as const, at: scheduledToUtc('2026-10-12', '08:00') };
const monOut = { kind: 'OUT' as const, at: scheduledToUtc('2026-10-12', '16:00') };
const tueIn = { kind: 'IN' as const, at: scheduledToUtc('2026-10-13', '08:00') };

describe('a punch correction', () => {
  it('may move a checkout anywhere between its check-in and the next punch', () => {
    expect(correctionProblem({ newAt: scheduledToUtc('2026-10-12', '17:30'), now, previous: monIn, next: tueIn })).toBeNull();
  });

  it('may not put a checkout before the check-in it closes', () => {
    const p = correctionProblem({ newAt: scheduledToUtc('2026-10-12', '06:00'), now, previous: monIn, next: tueIn });
    expect(p?.code).toBe('OUT_OF_ORDER');
    expect(p?.message).toContain('check-in at 2026-10-12 08:00');
  });

  it('may not carry a check-in past the checkout that follows it', () => {
    const p = correctionProblem({ newAt: scheduledToUtc('2026-10-12', '16:30'), now, previous: null, next: monOut });
    expect(p?.code).toBe('OUT_OF_ORDER');
    expect(p?.message).toContain('check-out at 2026-10-12 16:00');
  });

  it('may not land exactly on a neighbour, where the order is a coin toss', () => {
    expect(correctionProblem({ newAt: monIn.at, now, previous: monIn, next: null })?.code).toBe('OUT_OF_ORDER');
  });

  it('may not name a time that has not happened yet', () => {
    const p = correctionProblem({ newAt: scheduledToUtc('2026-10-14', '12:01'), now, previous: tueIn, next: null });
    expect(p?.code).toBe('IN_THE_FUTURE');
  });

  it('allows the first and the latest punch any past time on their open side', () => {
    expect(correctionProblem({ newAt: scheduledToUtc('2026-10-01', '08:00'), now, previous: null, next: monOut })).toBeNull();
    expect(correctionProblem({ newAt: scheduledToUtc('2026-10-14', '11:59'), now, previous: tueIn, next: null })).toBeNull();
  });
});
