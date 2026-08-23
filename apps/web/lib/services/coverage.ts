import { inBeirut, beirutWeekday } from 'time';

export interface PunchLite {
  kind: 'IN' | 'OUT';
  at: Date;
}

export interface OverrideLite {
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  shift_min: number | null;
}

/**
 * How many minutes one date required. A DAY_OFF override is always zero, an
 * HOURS_CHANGE override carrying an explicit shift_min beats the weekly
 * pattern, and everything else falls back to that weekday's Schedule.shift_min
 * - zero when the weekday is unscheduled.
 *
 * Exported because payroll is not the only reader: absence detection, the
 * missed-checkout job and the admin dashboard all have to agree with it. A day
 * that resolves to zero required minutes is a day off, never a no-show, and
 * each consumer re-deriving that produced a different answer.
 */
export function requiredMinFor(
  override: OverrideLite | null | undefined,
  weekdayShiftMin: number | null | undefined,
): number {
  if (override?.kind === 'DAY_OFF') return 0;
  if (override?.kind === 'HOURS_CHANGE' && override.shift_min !== null) return override.shift_min;
  return weekdayShiftMin ?? 0;
}

export interface DayCoverage {
  date: string; // YYYY-MM-DD (Beirut)
  requiredMin: number;
  workedMin: number;
  deltaMin: number; // worked - required; negative is a shortfall
  closed: boolean; // false while a check-in has no matching checkout
  lastPunchAt: Date; // used to resolve the rate in force that day
  // What this day actually earned, priced the way payroll prices it: every
  // IN/OUT interval at the rate in force when it closed, each floored on its
  // own. Not workedMin * one rate - a RateChange is stamped effective_from the
  // instant it is saved, so it can land in the middle of a workday and the two
  // answers diverge. Anything that wants to bound a day by its own pay has to
  // bound it by this figure or it can quietly overshoot into the next day.
  grossCent: number;
}

/**
 * How many minutes each day owed, how many were actually covered, and what the
 * covered ones earned. Pure - no DB. A shift belongs to the Beirut day the
 * employee checked IN, so an overnight shift needs no special casing: it is
 * simply that day's shift.
 *
 * `rateCentAt` is required rather than optional on purpose. It is only ever
 * `(at) => rateAt(rateChanges, at)`, but a caller that could omit it would get
 * a silent zero gross, and a zero gross is a valid-looking number that clamps
 * a whole day's penalty to nothing.
 */
export function computeCoverage(args: {
  punches: PunchLite[];
  shiftMinByWeekday: Map<number, number>;
  overridesByDate: Map<string, OverrideLite>;
  rateCentAt: (at: Date) => number;
}): DayCoverage[] {
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  const workedByDate = new Map<string, number>();
  const grossByDate = new Map<string, number>();
  const lastPunchByDate = new Map<string, Date>();
  // The weekday must come from the ARRIVAL, not the closing punch: an overnight
  // shift closes on the next calendar day, which is a different weekday.
  const arrivalByDate = new Map<string, Date>();
  const openDates = new Set<string>();

  let openIn: PunchLite | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p;
      continue;
    }
    if (!openIn) continue; // checkout with no arrival - ignore, as payout does
    const date = inBeirut(openIn.at).date;
    const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
    workedByDate.set(date, (workedByDate.get(date) ?? 0) + minutes);
    // Same expression payout.ts uses per interval, resolved at the SAME instant
    // (the checkout), so summing these across a month reproduces gross exactly.
    const intervalCent = Math.floor((minutes * args.rateCentAt(p.at)) / 60);
    grossByDate.set(date, (grossByDate.get(date) ?? 0) + intervalCent);
    lastPunchByDate.set(date, p.at);
    if (!arrivalByDate.has(date)) arrivalByDate.set(date, openIn.at);
    openIn = null;
  }
  if (openIn) {
    const date = inBeirut(openIn.at).date;
    openDates.add(date);
    if (!workedByDate.has(date)) workedByDate.set(date, 0);
    lastPunchByDate.set(date, openIn.at);
    if (!arrivalByDate.has(date)) arrivalByDate.set(date, openIn.at);
  }

  const days: DayCoverage[] = [];
  for (const [date, workedMin] of workedByDate) {
    const lastPunchAt = lastPunchByDate.get(date)!;
    const requiredMin = requiredMinFor(
      args.overridesByDate.get(date),
      args.shiftMinByWeekday.get(beirutWeekday(arrivalByDate.get(date)!)),
    );

    days.push({
      date,
      requiredMin,
      workedMin,
      deltaMin: workedMin - requiredMin,
      closed: !openDates.has(date),
      lastPunchAt,
      grossCent: grossByDate.get(date) ?? 0,
    });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

export interface ShiftDayMinutes {
  date: string; // YYYY-MM-DD (Beirut) - the shift-day these minutes belong to
  minutes: number;
  openInAt: Date | null; // the arrival still waiting for a checkout, if any
  staleOpenInAt: Date | null; // an arrival too old to be a real shift, ignored
}

/**
 * Past this, an open check-in is a forgotten checkout rather than a shift.
 *
 * Schedule.shift_min allows up to 1440, so a genuine 24-hour shift exists and
 * must never be truncated; six hours on top covers a very late checkout punch
 * without letting an abandoned session run away. missedCheckout has already
 * raised a MISSED_CHECKOUT flag long before this (it fires at the day's
 * required minutes plus the branch grace), so nothing is lost by stopping here
 * - the flag is where a forgotten checkout belongs, not the hours column.
 */
export const MAX_OPEN_SESSION_MIN = 30 * 60;

/**
 * How many minutes this user has worked on the shift-day they are currently on.
 *
 * The shift-day is the Beirut day of their open arrival if they have one, else
 * today - the same "a shift belongs to the day it started" rule computeCoverage
 * applies, rather than "rows whose timestamp lands in today's calendar day".
 * That is what keeps a 21:00-07:00 shift counting past midnight instead of
 * vanishing at it, and what makes a second session add to the first rather than
 * replace it.
 *
 * Callers must query punches far enough back to include a previous-day arrival.
 */
export function currentShiftDayMinutes(args: { punches: PunchLite[]; now: Date }): ShiftDayMinutes {
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  const closedByDate = new Map<string, number>();
  let openIn: Date | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p.at;
      continue;
    }
    if (!openIn) continue; // checkout with no arrival - ignore, as payout does
    const date = inBeirut(openIn).date;
    const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.getTime()) / 60_000));
    closedByDate.set(date, (closedByDate.get(date) ?? 0) + minutes);
    openIn = null;
  }

  // Nobody works for days on end: an open session past MAX_OPEN_SESSION_MIN is
  // somebody who forgot to punch out, and counting it would put 40-odd hours
  // into today's total and today's labour cost. Drop it and let the
  // MISSED_CHECKOUT flag speak instead - reported separately so a caller can
  // still tell an abandoned punch from no punch at all.
  const openMinRaw = openIn ? Math.max(0, Math.floor((args.now.getTime() - openIn.getTime()) / 60_000)) : 0;
  const stale = openIn !== null && openMinRaw > MAX_OPEN_SESSION_MIN;
  const live = stale ? null : openIn;

  const date = inBeirut(live ?? args.now).date;
  const openMin = live ? openMinRaw : 0;
  return {
    date,
    minutes: (closedByDate.get(date) ?? 0) + openMin,
    openInAt: live,
    staleOpenInAt: stale ? openIn : null,
  };
}
