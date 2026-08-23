import { describe, it, expect } from 'vitest';
import {
  coverageWithBlockedCredit,
  grantedIntervals,
  type BlockedAttemptLite,
  type CreditDecisionLite,
} from './blockedCredit';
import { computeCoverage, type PunchLite } from './coverage';
import { computeOvertime } from './overtime';
import { currentShiftDate, shortfallPenalties } from './penalty';
import { computePayoutFromRows, rateAt } from './payout';

// 2026-08-17 is a Monday; Beirut is UTC+3 in August.
const DATE = '2026-08-17';
const NEXT_DAY = new Date('2026-08-18T09:00:00Z');
const RATE = 200; // $2.00/h
const RATES = [{ rate_cent: RATE, effective_from: new Date('2020-01-01T00:00:00Z') }];

function beirut(hhmm: string, date = DATE): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 7, Number(date.slice(8, 10)), (h as number) - 3, m as number, 0, 0));
}

function shiftOf(min: number): Map<number, number> {
  return new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, min] as const));
}

function build(args: {
  punches: PunchLite[];
  attempts?: BlockedAttemptLite[];
  shiftMin: number;
  rates?: { rate_cent: number; effective_from: Date }[];
  decisions?: Map<string, CreditDecisionLite>;
}) {
  const rates = args.rates ?? RATES;
  return coverageWithBlockedCredit({
    punches: args.punches,
    shiftMinByWeekday: shiftOf(args.shiftMin),
    overridesByDate: new Map(),
    rateCentAt: (at) => rateAt(rates, at),
    attempts: args.attempts ?? [],
    decisionsByDate: args.decisions ?? new Map(),
  });
}

function penaltiesFor(
  coverage: ReturnType<typeof build>['coverage'],
  punches: PunchLite[],
  graceMin = 15,
) {
  return shortfallPenalties({
    coverage,
    rateChanges: RATES,
    graceMin,
    currentShiftDate: currentShiftDate(punches, NEXT_DAY),
    waivers: new Map(),
  });
}

describe('blocked-time credit', () => {
  // The failure it exists for: an employee turned away at 06:00 by somebody
  // else's forgotten checkout, finally let in at 08:00, then docked for the
  // two hours the app would not let them clock.
  const BLOCKED_AT = beirut('06:00');
  const punches: PunchLite[] = [
    { kind: 'IN', at: beirut('08:00') },
    { kind: 'OUT', at: beirut('14:00') },
  ];

  it('without the credit, waiting costs them the day', () => {
    const { coverage } = build({ punches, shiftMin: 480 });
    const day = coverage[0]!;
    expect(day.workedMin).toBe(360);
    expect(day.deltaMin).toBe(-120);
    // 2 x 120 min short, ceilinged at the 360 worked, at $2.00/h.
    expect(penaltiesFor(coverage, punches).map((p) => p.amount_cent)).toEqual([800]);
  });

  const ACCEPTED = new Map<string, CreditDecisionLite>([
    [DATE, { decision: 'ACCEPTED', credited_min: 120 }],
  ]);

  it('proposes the credit but grants nothing until the owner accepts', () => {
    // The cap does not bound the exposure so much as size the credit to fill
    // the day: one tap at 06:00, back at 15:00, an hour clocked, and an
    // automatic credit would hand over a full day's gross. So a pending day
    // must read exactly as if the employee had never been blocked.
    const { coverage, credits } = build({ punches, attempts: [{ at: BLOCKED_AT }], shiftMin: 480 });
    const untouched = build({ punches, shiftMin: 480 });

    expect(credits).toHaveLength(1);
    expect(credits[0]!.decision).toBeNull();
    expect(credits[0]!.creditedMin).toBe(120);
    expect(credits[0]!.amount_cent).toBe(400); // what accepting would be worth

    // Nothing granted: no minutes, no gross, no interval, and the shortfall
    // penalty still stands.
    expect(grantedIntervals(credits)).toEqual([]);
    expect(coverage).toEqual(untouched.coverage);
    expect(coverage[0]!.workedMin).toBe(360);
    expect(coverage[0]!.grossCent).toBe(1200);
    expect(penaltiesFor(coverage, punches).map((p) => p.amount_cent)).toEqual([800]);
  });

  it('starts the day at the first blocked attempt once accepted, and clears the shortfall', () => {
    const { coverage, credits } = build({
      punches,
      attempts: [{ at: BLOCKED_AT }],
      shiftMin: 480,
      decisions: ACCEPTED,
    });

    expect(credits).toHaveLength(1);
    const credit = credits[0]!;
    expect(credit.date).toBe(DATE);
    expect(credit.blockedAt.toISOString()).toBe(BLOCKED_AT.toISOString());
    expect(credit.clockedInAt.toISOString()).toBe(beirut('08:00').toISOString());
    expect(credit.creditedMin).toBe(120);
    expect(credit.amount_cent).toBe(400); // 2h at $2.00
    expect(credit.decision).toBe('ACCEPTED');

    const day = coverage[0]!;
    expect(day.workedMin).toBe(480); // 06:00 to 14:00, not 08:00 to 14:00
    expect(day.deltaMin).toBe(0);
    expect(day.grossCent).toBe(1600); // the full 8h, credit included
    expect(penaltiesFor(coverage, punches)).toEqual([]);
  });

  it('uses the earliest blocked attempt of the day, not the last one before they got in', () => {
    const { credits } = build({
      punches,
      attempts: [{ at: beirut('07:30') }, { at: BLOCKED_AT }, { at: beirut('06:40') }],
      shiftMin: 480,
    });
    expect(credits[0]!.blockedAt.toISOString()).toBe(BLOCKED_AT.toISOString());
    expect(credits[0]!.creditedMin).toBe(120);
  });

  it('caps the credit at the day required, so waiting can never become overtime', () => {
    // Turned away at 03:00, in at 08:00, out at 15:00: 7h clocked and 5h waited
    // is 12h against an 8h day. Only the 1h of headroom is credited.
    const longWait: PunchLite[] = [
      { kind: 'IN', at: beirut('08:00') },
      { kind: 'OUT', at: beirut('15:00') },
    ];
    const { coverage, credits } = build({
      punches: longWait,
      attempts: [{ at: beirut('03:00') }],
      shiftMin: 480,
      decisions: new Map([[DATE, { decision: 'ACCEPTED', credited_min: 60 }]]),
    });

    expect(
      computeOvertime({ coverage, rateChanges: RATES, graceMin: 15, decisionsByDate: new Map() }),
    ).toEqual([]);
    expect(credits[0]!.waitedMin).toBe(300);
    expect(credits[0]!.creditedMin).toBe(60);
    const day = coverage[0]!;
    expect(day.workedMin).toBe(480);
    expect(day.deltaMin).toBe(0);
  });

  it('credits nothing on a day already at or past its required hours', () => {
    const fullDay: PunchLite[] = [
      { kind: 'IN', at: beirut('08:00') },
      { kind: 'OUT', at: beirut('16:00') },
    ];
    const { coverage, credits } = build({
      punches: fullDay,
      attempts: [{ at: beirut('06:00') }],
      shiftMin: 480,
    });
    expect(credits).toEqual([]);
    expect(coverage[0]!.workedMin).toBe(480);
    expect(coverage[0]!.deltaMin).toBe(0);
  });

  it('leaves a genuine overtime day exactly as it was', () => {
    const overtimeDay: PunchLite[] = [
      { kind: 'IN', at: beirut('08:00') },
      { kind: 'OUT', at: beirut('22:00') },
    ];
    const attempts = [{ at: beirut('06:00') }];
    const withAttempt = build({ punches: overtimeDay, attempts, shiftMin: 480 });
    const without = computeCoverage({
      punches: overtimeDay,
      shiftMinByWeekday: shiftOf(480),
      overridesByDate: new Map(),
      rateCentAt: (at) => rateAt(RATES, at),
    });
    expect(withAttempt.credits).toEqual([]);
    expect(withAttempt.coverage).toEqual(without);
    expect(withAttempt.coverage[0]!.deltaMin).toBe(360);
  });

  it('credits nothing when the blocking session started that same day', () => {
    // In at 02:00, forgot to punch out, refused at 06:00, admin closed it, in
    // again at 08:00. The 02:00 session's own minutes already cover that
    // stretch - crediting the wait as well would pay it twice.
    const sameDay: PunchLite[] = [
      { kind: 'IN', at: beirut('02:00') },
      { kind: 'OUT', at: beirut('05:00') },
      { kind: 'IN', at: beirut('08:00') },
      { kind: 'OUT', at: beirut('12:00') },
    ];
    const { credits } = build({ punches: sameDay, attempts: [{ at: beirut('06:00') }], shiftMin: 480 });
    expect(credits).toEqual([]);
  });

  it('revoking moves no money, because nothing had been granted', () => {
    const decisions = new Map<string, CreditDecisionLite>([
      [DATE, { decision: 'REVOKED', credited_min: 120 }],
    ]);
    const revoked = build({ punches, attempts: [{ at: BLOCKED_AT }], shiftMin: 480, decisions });
    const pending = build({ punches, attempts: [{ at: BLOCKED_AT }], shiftMin: 480 });

    expect(revoked.credits[0]!.decision).toBe('REVOKED');
    expect(grantedIntervals(revoked.credits)).toEqual([]);
    expect(revoked.coverage).toEqual(pending.coverage);
    expect(penaltiesFor(revoked.coverage, punches).map((p) => p.amount_cent)).toEqual([800]);
  });

  it('an acceptance made against a different figure grants nothing until re-ruled', () => {
    // The owner accepted 90 minutes; a correction has since made it 120. The
    // safe default is inverted from overtime here - pending credit is NOT paid
    // - so "stale reads as pending" holds the money back rather than handing
    // it over. That matters: the cap sizes credit to fill the day, so a deleted
    // punch could turn an approved 30 minutes into an approved eight hours.
    const decisions = new Map<string, CreditDecisionLite>([
      [DATE, { decision: 'ACCEPTED', credited_min: 90 }],
    ]);
    const { coverage, credits } = build({ punches, attempts: [{ at: BLOCKED_AT }], shiftMin: 480, decisions });
    expect(credits[0]!.decision).toBeNull();
    expect(coverage[0]!.workedMin).toBe(360);
    expect(coverage[0]!.grossCent).toBe(1200);
  });

  it('never credits minutes an earlier day is already paying for', () => {
    // A 21:00 Sunday shift closes at 07:00 Monday and belongs to Sunday. A
    // Monday 06:00 tap is refused while it is still open; they get in at 09:00.
    // Crediting from 06:00 would pay 06:00-07:00 twice - once inside Sunday's
    // interval, once as Monday's credit.
    const overnight: PunchLite[] = [
      { kind: 'IN', at: beirut('21:00', '2026-08-16') },
      { kind: 'OUT', at: beirut('07:00') },
      { kind: 'IN', at: beirut('09:00') },
      { kind: 'OUT', at: beirut('13:00') },
    ];
    const { credits } = build({
      punches: overnight,
      attempts: [{ at: beirut('06:00') }],
      shiftMin: 480,
    });

    expect(credits).toHaveLength(1);
    expect(credits[0]!.blockedAt.toISOString()).toBe(beirut('06:00').toISOString());
    // Credited from 07:00, where Sunday's pay actually stops - not 06:00.
    expect(credits[0]!.creditFromAt.toISOString()).toBe(beirut('07:00').toISOString());
    expect(credits[0]!.waitedMin).toBe(120);
    expect(credits[0]!.creditedMin).toBe(120);
  });

  it('prices the credit at the rate in force when the wait ended, as payroll prices a shift', () => {
    // A raise saved at 07:00, in the middle of the wait. payout.ts resolves a
    // worked interval's rate at its closing punch; the credited stretch closes
    // when they finally clock in, so it takes the new rate the same way.
    const rates = [
      { rate_cent: 200, effective_from: new Date('2020-01-01T00:00:00Z') },
      { rate_cent: 500, effective_from: beirut('07:00') },
    ];
    const { credits } = build({ punches, attempts: [{ at: BLOCKED_AT }], shiftMin: 480, rates });
    expect(credits[0]!.rate_cent).toBe(500);
    expect(credits[0]!.amount_cent).toBe(1000); // 120 min at $5.00/h
  });
});

/**
 * The reconciliation the whole design turns on.
 *
 * Gross reaches payroll through pairHours, and the penalty ceiling comes from
 * each day's coverage.grossCent. Those two agreed to the cent before credited
 * time existed - same pairing, same per-interval flooring, same rate instant -
 * and the "a day can never go negative" guarantee is only exact because they
 * do. Credit landing in one and not the other breaks both quietly.
 */
describe('credited time keeps pairHours and per-day gross in agreement', () => {
  function reconcile(args: {
    punches: PunchLite[];
    attempts: BlockedAttemptLite[];
    shiftMin: number;
    rates: { rate_cent: number; effective_from: Date }[];
    accept?: boolean;
  }) {
    const inputs = {
      punches: args.punches,
      shiftMinByWeekday: shiftOf(args.shiftMin),
      overridesByDate: new Map(),
      rateCentAt: (at: Date) => rateAt(args.rates, at),
      attempts: args.attempts,
    };
    // Credit grants nothing until it is accepted, so a sweep left on the
    // default would reconcile two numbers that are both credit-free - the
    // definition of a vacuous property test. Accept every proposed day at the
    // figure the server would stamp, exactly as the decision route does.
    const decisionsByDate = new Map<string, CreditDecisionLite>();
    if (args.accept !== false) {
      for (const c of coverageWithBlockedCredit({ ...inputs, decisionsByDate: new Map() }).credits) {
        decisionsByDate.set(c.date, { decision: 'ACCEPTED', credited_min: c.creditedMin });
      }
    }
    const { coverage, credits } = coverageWithBlockedCredit({ ...inputs, decisionsByDate });
    const monthGross = computePayoutFromRows({
      userId: 'u1',
      punches: args.punches.map((p, i) => ({ id: `p${i}`, user_id: 'u1', kind: p.kind, at: p.at })),
      rateChanges: args.rates.map((r) => ({ user_id: 'u1', ...r })),
      adjustments: [],
      approvedAdvances: [],
      creditedIntervals: grantedIntervals(credits),
    }).grossCent;
    const perDayGross = coverage.reduce((s, d) => s + d.grossCent, 0);
    return { monthGross, perDayGross, coverage, credits, granted: grantedIntervals(credits) };
  }

  it('agrees across several credited days and a mid-shift raise', () => {
    const rates = [
      { rate_cent: 237, effective_from: new Date('2020-01-01T00:00:00Z') },
      { rate_cent: 913, effective_from: beirut('11:17', '2026-08-18') },
    ];
    const punches: PunchLite[] = [
      { kind: 'IN', at: beirut('08:03') },
      { kind: 'OUT', at: beirut('13:41') },
      { kind: 'IN', at: beirut('07:12', '2026-08-18') },
      { kind: 'OUT', at: beirut('12:55', '2026-08-18') },
      { kind: 'IN', at: beirut('09:00', '2026-08-19') },
      { kind: 'OUT', at: beirut('17:30', '2026-08-19') },
    ];
    const attempts = [
      { at: beirut('06:44') },
      { at: beirut('05:09', '2026-08-18') },
      { at: beirut('08:50', '2026-08-19') },
    ];
    const accepted = reconcile({ punches, attempts, shiftMin: 480, rates });
    expect(accepted.granted.length).toBeGreaterThan(0);
    expect(accepted.monthGross).toBe(accepted.perDayGross);

    // And with the same days left pending, where the credit reaches neither
    // side. Both states have to reconcile, not just the granted one.
    const pending = reconcile({ punches, attempts, shiftMin: 480, rates, accept: false });
    expect(pending.granted).toEqual([]);
    expect(pending.monthGross).toBe(pending.perDayGross);
    expect(pending.monthGross).toBeLessThan(accepted.monthGross);
  });

  /**
   * Deterministic sweep, same fixed-seed LCG as penalty-bound.test.ts: a
   * failure names one reproducible case rather than a run nobody can repeat.
   */
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 4294967296;
    };
  }

  it('agrees over 2000 generated days, and no credited day goes negative', () => {
    const rand = lcg(20260823);
    let credited = 0;
    let worstMargin = Number.POSITIVE_INFINITY;

    for (let n = 0; n < 2000; n++) {
      const dayNum = 17 + Math.floor(rand() * 3);
      const date = `2026-08-${dayNum}`;
      const inMin = Math.floor(rand() * 600);
      const lenMin = 1 + Math.floor(rand() * 500);
      const punches: PunchLite[] = [
        { kind: 'IN', at: new Date(beirut('00:00', date).getTime() + inMin * 60_000) },
        { kind: 'OUT', at: new Date(beirut('00:00', date).getTime() + (inMin + lenMin) * 60_000) },
      ];
      // Blocked somewhere before the check-in, sometimes not at all.
      const attempts: BlockedAttemptLite[] =
        rand() < 0.75
          ? [
              {
                at: new Date(
                  beirut('00:00', date).getTime() + Math.max(0, inMin - Math.floor(rand() * 400)) * 60_000,
                ),
              },
            ]
          : [];
      const rates = [{ rate_cent: 50 + Math.floor(rand() * 950), effective_from: new Date('2020-01-01T00:00:00Z') }];
      if (rand() < 0.5) {
        rates.push({
          rate_cent: 50 + Math.floor(rand() * 950),
          effective_from: new Date(beirut('00:00', date).getTime() + Math.floor(rand() * 1440) * 60_000),
        });
      }
      rates.sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime());
      const shiftMin = [0, 60, 240, 480, 720][Math.floor(rand() * 5)]!;
      const graceMin = Math.floor(rand() * 61);

      const r = reconcile({ punches, attempts, shiftMin, rates });
      if (r.granted.length > 0) credited += 1;
      expect(r.monthGross).toBe(r.perDayGross);

      const penaltyCent = shortfallPenalties({
        coverage: r.coverage,
        rateChanges: rates,
        graceMin,
        currentShiftDate: currentShiftDate(punches, new Date('2026-08-25T09:00:00Z')),
        waivers: new Map(),
      }).reduce((s, p) => s + p.amount_cent, 0);
      const margin = r.monthGross - penaltyCent;
      if (margin < worstMargin) worstMargin = margin;
      expect(margin).toBeGreaterThanOrEqual(0);
    }

    // The sweep is worthless if credit almost never happened in it.
    expect(credited).toBeGreaterThan(500);
  });
});
