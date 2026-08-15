import { inBeirut, beirutWeekday } from 'time';

export interface PunchLite {
  kind: 'IN' | 'OUT';
  at: Date;
}

export interface OverrideLite {
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  shift_min: number | null;
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
    const override = args.overridesByDate.get(date);

    let requiredMin: number;
    if (override?.kind === 'DAY_OFF') {
      requiredMin = 0;
    } else if (override?.kind === 'HOURS_CHANGE' && override.shift_min !== null) {
      requiredMin = override.shift_min;
    } else {
      requiredMin = args.shiftMinByWeekday.get(beirutWeekday(arrivalByDate.get(date)!)) ?? 0;
    }

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
