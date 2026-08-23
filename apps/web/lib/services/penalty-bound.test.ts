import { describe, it, expect } from 'vitest';
import { currentShiftDate, shortfallPenalties } from './penalty';
import { computeCoverage, type PunchLite } from './coverage';
import { computePayoutFromRows, rateAt } from './payout';

/**
 * The ceiling exists so one bad day can cost that day's pay and nothing more.
 * The worked cases pin the shapes that broke it; this sweeps the space around
 * them, because the two ways it went wrong before - a rate change landing
 * mid-workday and per-interval rounding - were both found by reasoning about
 * inputs nobody had thought to write a case for.
 *
 * Deterministic: a fixed-seed LCG, so a failure names one reproducible case
 * rather than a run that cannot be repeated.
 */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const DAY_START_MS = Date.parse('2026-08-16T21:00:00Z'); // 2026-08-17 00:00 Beirut
const NEXT_DAY = new Date('2026-08-18T09:00:00Z');
const SHIFTS = [0, 60, 240, 480, 720];

interface Case {
  punches: PunchLite[];
  rates: { rate_cent: number; effective_from: Date }[];
  shiftMin: number;
  graceMin: number;
}

function buildCase(rand: () => number): Case {
  const sessions = 1 + Math.floor(rand() * 4);
  const punches: PunchLite[] = [];
  let cursor = Math.floor(rand() * 120); // minutes into the Beirut day
  for (let i = 0; i < sessions; i++) {
    const len = 1 + Math.floor(rand() * 300);
    const inAt = new Date(DAY_START_MS + cursor * 60_000);
    const outAt = new Date(DAY_START_MS + (cursor + len) * 60_000);
    punches.push({ kind: 'IN', at: inAt }, { kind: 'OUT', at: outAt });
    cursor += len + 1 + Math.floor(rand() * 90);
  }

  const rateCount = 1 + Math.floor(rand() * 3);
  const rates = [{ rate_cent: 50 + Math.floor(rand() * 950), effective_from: new Date('2020-01-01T00:00:00Z') }];
  for (let i = 1; i < rateCount; i++) {
    // Deliberately inside the working day: a RateChange is stamped
    // effective_from the instant it is saved, so this is the real shape.
    rates.push({
      rate_cent: 50 + Math.floor(rand() * 950),
      effective_from: new Date(DAY_START_MS + Math.floor(rand() * 1440) * 60_000),
    });
  }
  rates.sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime());

  return {
    punches,
    rates,
    shiftMin: SHIFTS[Math.floor(rand() * SHIFTS.length)]!,
    graceMin: Math.floor(rand() * 61),
  };
}

function grossCentFor(c: Case): number {
  return computePayoutFromRows({
    userId: 'u1',
    punches: c.punches.map((p, i) => ({ id: `p${i}`, user_id: 'u1', kind: p.kind, at: p.at })),
    rateChanges: c.rates.map((r) => ({ user_id: 'u1', ...r })),
    adjustments: [],
    approvedAdvances: [],
  }).grossCent;
}

function penaltyCentFor(c: Case): number {
  const items = shortfallPenalties({
    coverage: computeCoverage({
      punches: c.punches,
      shiftMinByWeekday: new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, c.shiftMin] as const)),
      overridesByDate: new Map(),
      rateCentAt: (at) => rateAt(c.rates, at),
    }),
    rateChanges: c.rates,
    graceMin: c.graceMin,
    currentShiftDate: currentShiftDate(c.punches, NEXT_DAY),
    waivers: new Map(),
  });
  return items.reduce((sum, i) => sum + i.amount_cent, 0);
}

describe('the penalty bound holds across the input space', () => {
  it('never takes more than the day paid, over 4000 generated days', () => {
    const rand = lcg(20260823);
    let worstMargin = Number.POSITIVE_INFINITY;
    let penalised = 0;

    for (let n = 0; n < 4000; n++) {
      const c = buildCase(rand);
      const gross = grossCentFor(c);
      const penalty = penaltyCentFor(c);
      const margin = gross - penalty;
      if (penalty > 0) penalised += 1;
      if (margin < worstMargin) worstMargin = margin;
      if (margin < 0) {
        throw new Error(
          `day went negative by ${-margin}c: gross=${gross} penalty=${penalty} ` +
            `shift=${c.shiftMin} grace=${c.graceMin} ` +
            `punches=${c.punches.map((p) => `${p.kind}@${p.at.toISOString()}`).join(',')} ` +
            `rates=${c.rates.map((r) => `${r.rate_cent}@${r.effective_from.toISOString()}`).join(',')}`,
        );
      }
    }

    // The sweep is worthless if it never provoked a penalty, and worthless
    // again if the ceiling never actually bound.
    expect(penalised).toBeGreaterThan(1000);
    expect(worstMargin).toBe(0);
  });
});
