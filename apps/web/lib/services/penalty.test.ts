import { describe, it, expect } from 'vitest';
import { currentShiftDate, penaltyMinutes, shortfallPenalties, sumActivePenaltiesCent } from './penalty';
import type { PenaltyDecisionLite } from './penalty';
import { computeCoverage, type DayCoverage, type PunchLite } from './coverage';

const RATE = [{ rate_cent: 60_000, effective_from: new Date('2020-01-01T00:00:00Z') }];
// The owner's own numbers: $2.00/h against an 8-hour day.
const REAL_RATE = [{ rate_cent: 200, effective_from: new Date('2020-01-01T00:00:00Z') }];
const SHIFT_MIN = 480;
const GRACE = 15;
// Every fixture day is 2026-08-17; judging happens on a later shift-day unless a
// test says otherwise, so the fixture day is never the one being skipped.
const LATER_DAY = '2026-08-18';

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
    currentShiftDate: LATER_DAY,
    waivers: new Map(),
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
      currentShiftDate: LATER_DAY,
      waivers: new Map(),
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
      currentShiftDate: LATER_DAY,
      waivers: new Map(),
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
        currentShiftDate: LATER_DAY,
        waivers: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('ignores a day that met its hours', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: SHIFT_MIN })],
        rateChanges: RATE,
        graceMin: GRACE,
        currentShiftDate: LATER_DAY,
        waivers: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('ignores overtime', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 600 })],
        rateChanges: RATE,
        graceMin: GRACE,
        currentShiftDate: LATER_DAY,
        waivers: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('does not judge an unclosed day', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 0, closed: false })],
        rateChanges: RATE,
        graceMin: GRACE,
        currentShiftDate: LATER_DAY,
        waivers: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('marks a waived day', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360 })],
      rateChanges: RATE,
      graceMin: GRACE,
      currentShiftDate: LATER_DAY,
      waivers: waiverAt(240),
    });
    expect(items[0]!.waived).toBe(true);
  });
});

// A stored waiver on the fixture day, recorded against `penaltyMin` minutes.
function waiverAt(penaltyMin: number | null): Map<string, PenaltyDecisionLite> {
  return new Map([['2026-08-17|SHORTFALL', { penalty_min: penaltyMin }]]);
}

describe('a waiver keeps forgiving; only review depends on the figure', () => {
  function judgeWaived(workedMin: number, waivers: Map<string, PenaltyDecisionLite>) {
    return shortfallPenalties({
      coverage: [day({ workedMin })],
      rateChanges: REAL_RATE,
      graceMin: GRACE,
      currentShiftDate: LATER_DAY,
      waivers,
    });
  }

  it('forgives, and asks for nothing, while the waiver names the figure the day has', () => {
    // 360 worked, 120 short, 240 docked - the amount the waiver was given for.
    const item = judgeWaived(360, waiverAt(240))[0]!;
    expect(item.waived).toBe(true);
    expect(item.waiverStale).toBe(false);
  });

  it('keeps forgiving once a correction moves the day, and flags it for review', () => {
    // The owner removed a penalty of 240 docked minutes. A corrected punch makes
    // it 300. Dropping the removal here would take back money he had already
    // decided to give: an undecided shortfall is docked, so ignoring the stale
    // row robs the employee rather than protecting them.
    const item = judgeWaived(330, waiverAt(240))[0]!;
    expect(item.penaltyMin).toBe(300);
    expect(item.waived).toBe(true);
    expect(item.waiverStale).toBe(true);
  });

  it('deducts nothing for a stale waiver', () => {
    expect(sumActivePenaltiesCent(judgeWaived(330, waiverAt(240)))).toBe(0);
  });

  it('keeps forgiving on a waiver that recorded no amount, and flags that too', () => {
    // Any row written before penalty_min existed. It names no amount, so it can
    // never match - but it is still the owner's removal, so the money stays put
    // and nothing needs backfilling.
    const item = judgeWaived(360, waiverAt(null))[0]!;
    expect(item.waived).toBe(true);
    expect(item.waiverStale).toBe(true);
    expect(sumActivePenaltiesCent([item])).toBe(0);
  });

  it('docks a day with no waiver at all', () => {
    const item = judgeWaived(360, new Map())[0]!;
    expect(item.waived).toBe(false);
    expect(item.waiverStale).toBe(false);
    expect(sumActivePenaltiesCent([item])).toBe(item.amount_cent);
  });
});

// Beirut is UTC+3 in August. 2026-08-17 is a Monday.
const ALL_DAYS_8H = new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, SHIFT_MIN] as const));

function punches(...pairs: Array<[string, 'IN' | 'OUT']>): PunchLite[] {
  return pairs.map(([iso, kind]) => ({ kind, at: new Date(iso) }));
}

// Exactly what penaltiesForUser does with what it loads: coverage, then the
// current shift-day from the same punches, then the judgement.
function judge(list: PunchLite[], now: Date) {
  return shortfallPenalties({
    coverage: computeCoverage({
      punches: list,
      shiftMinByWeekday: ALL_DAYS_8H,
      overridesByDate: new Map(),
    }),
    rateChanges: REAL_RATE,
    graceMin: GRACE,
    currentShiftDate: currentShiftDate(list, now),
    waivers: new Map(),
  });
}

// Mon 08:00-12:00 Beirut, out, back 17:00-20:00. 420 of 480 minutes covered.
const MORNING = punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T09:00:00Z', 'OUT']);
const EVENING = punches(['2026-08-17T14:00:00Z', 'IN'], ['2026-08-17T17:00:00Z', 'OUT']);
const SPLIT_SHIFT = [...MORNING, ...EVENING];

describe('a day is only judged once it is over', () => {
  it('does not judge a split shift between its sessions', () => {
    // 13:00 Mon Beirut. The morning pair is closed and nothing is open, so
    // `closed` alone says judge it - and judging it here invents a 4h shortfall
    // that disappears the moment they come back at 17:00.
    expect(judge(MORNING, new Date('2026-08-17T10:00:00Z'))).toHaveLength(0);
  });

  it('judges the split shift once the day is over, counting both sessions', () => {
    // Tue 10:00 Beirut. 60 min short, not the 240 the morning alone would show
    // nor the 300 the evening alone would.
    const items = judge(SPLIT_SHIFT, new Date('2026-08-18T07:00:00Z'));
    expect(items).toHaveLength(1);
    expect(items[0]!.date).toBe('2026-08-17');
    expect(items[0]!.shortfallMin).toBe(60);
    expect(items[0]!.penaltyMin).toBe(120);
    expect(items[0]!.amount_cent).toBe(400);
  });

  it('turns over at the Beirut day boundary, not the UTC one', () => {
    // Both instants fall on 2026-08-17 in UTC. In Beirut the first is 23:00 Mon
    // and the second is 01:00 Tue, so only the second may judge Monday. Reading
    // the clock in UTC makes these two indistinguishable.
    expect(judge(SPLIT_SHIFT, new Date('2026-08-17T20:00:00Z'))).toHaveLength(0);
    expect(judge(SPLIT_SHIFT, new Date('2026-08-17T22:00:00Z'))).toHaveLength(1);
  });

  it('judges an overnight shift on the day it checked in', () => {
    // In 21:00 Mon Beirut, out 04:00 Tue Beirut: 420 min against Monday's 480.
    const overnight = punches(['2026-08-17T18:00:00Z', 'IN'], ['2026-08-18T01:00:00Z', 'OUT']);
    const items = judge(overnight, new Date('2026-08-18T07:00:00Z'));
    expect(items).toHaveLength(1);
    expect(items[0]!.date).toBe('2026-08-17');
    expect(items[0]!.shortfallMin).toBe(60);
    expect(items[0]!.penaltyMin).toBe(120);
  });

  it('holds the overnight shift open on its check-in day while it is still running', () => {
    // 03:30 Tue Beirut, still clocked in from 21:00 Monday. The shift-day is
    // Monday - where the arrival is - and the instant is 2026-08-18 in UTC, so
    // neither "today" nor the UTC date can produce this answer by accident.
    const open = punches(['2026-08-17T18:00:00Z', 'IN']);
    expect(currentShiftDate(open, new Date('2026-08-18T00:30:00Z'))).toBe('2026-08-17');
  });

  it('still judges a day the employee is no longer on', () => {
    // The guard is one day wide. Monday's shortfall is judged on Tuesday even
    // though Tuesday has its own open session running.
    const withTuesday = [...SPLIT_SHIFT, ...punches(['2026-08-18T05:00:00Z', 'IN'])];
    const items = judge(withTuesday, new Date('2026-08-18T07:00:00Z'));
    expect(items).toHaveLength(1);
    expect(items[0]!.date).toBe('2026-08-17');
  });
});
