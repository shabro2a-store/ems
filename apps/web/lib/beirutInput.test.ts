import { describe, it, expect } from 'vitest';
import { toBeirutInput, fromBeirutInput } from './beirutInput';

/*
 * The correction form's "New time (Beirut)" box. It was filled with the UTC
 * digits of the punch and read back in the browser's zone, so on a Beirut
 * laptop every save that left the time alone moved the punch three hours
 * earlier (two in winter).
 */
describe('the Beirut time box', () => {
  it('shows a summer punch in Beirut time', () => {
    expect(toBeirutInput('2026-09-26T05:00:00.000Z')).toBe('2026-09-26T08:00');
  });

  it('shows a winter punch in Beirut time', () => {
    expect(toBeirutInput('2026-12-01T06:00:00.000Z')).toBe('2026-12-01T08:00');
  });

  it('shows the Beirut date when UTC is still on the day before', () => {
    expect(toBeirutInput('2026-09-25T22:30:00.000Z')).toBe('2026-09-26T01:30');
  });

  it('reads what was typed as Beirut time, whatever zone the browser is in', () => {
    expect(fromBeirutInput('2026-09-26T08:00')).toBe('2026-09-26T05:00:00.000Z');
    expect(fromBeirutInput('2026-12-01T08:00')).toBe('2026-12-01T06:00:00.000Z');
  });

  it('gives back the same instant when nothing was changed', () => {
    const at = '2026-09-26T05:17:00.000Z';
    expect(fromBeirutInput(toBeirutInput(at))).toBe(at);
  });
});
