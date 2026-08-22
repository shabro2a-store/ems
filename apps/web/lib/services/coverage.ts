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
}

/**
 * How many minutes each day owed and how many were actually covered.
 * Pure - no DB. A shift belongs to the Beirut day the employee checked IN, so
 * an overnight shift needs no special casing: it is simply that day's shift.
 */
export function computeCoverage(args: {
  punches: PunchLite[];
  shiftMinByWeekday: Map<number, number>;
  overridesByDate: Map<string, OverrideLite>;
}): DayCoverage[] {
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  const workedByDate = new Map<string, number>();
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
    });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

export interface ShiftDayMinutes {
  date: string; // YYYY-MM-DD (Beirut) - the shift-day these minutes belong to
  minutes: number;
  openInAt: Date | null; // the arrival still waiting for a checkout, if any
}

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

  const date = inBeirut(openIn ?? args.now).date;
  const openMin = openIn ? Math.max(0, Math.floor((args.now.getTime() - openIn.getTime()) / 60_000)) : 0;
  return { date, minutes: (closedByDate.get(date) ?? 0) + openMin, openInAt: openIn };
}
