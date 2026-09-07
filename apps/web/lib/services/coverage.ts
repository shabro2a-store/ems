import { shiftDateOf, beirutWeekday, assignWorkingDays, REST_RULE_FROM, SHIFT_GAP_MIN } from 'time';

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

/**
 * The working-day boundary that applies to one person.
 *
 * Theirs, or midnight. Deliberately NOT their branch's any more.
 *
 * A branch cannot hold this setting, because every branch that used it held
 * both kinds of worker at once - Hamra's dani started before 04:00 on every
 * shift he worked and needed it, Hamra's ghayth.s did it once in nineteen and
 * was only harmed by it. While it lived on the branch the DEFAULT was the
 * harmful one: Bilal inherited a boundary nobody chose for him, one late start
 * filed a sixteen-hour shift under a day he had already worked, and sixteen
 * hours left September for a month that closed before it could be corrected.
 * Every new hire at those branches inherited the same trap, and the owner had
 * to remember to turn it off for each of them, forever.
 *
 * Now nobody has a boundary unless somebody deliberately gave them one. Null -
 * a new account, an employee never configured, a branch change - is midnight,
 * and midnight cannot move a shift anywhere: shiftDateOf at 0 reproduces
 * inBeirut().date exactly, by construction.
 *
 * Exported for the same reason requiredMinFor is: payroll, penalties, overtime,
 * blocked credit, the punch guard, the auto-close and the absence sweep must
 * all answer "which day is this" identically, and each re-deriving it is how
 * they stop agreeing.
 */
export function dayStartHourFor(
  user: { day_start_hour?: number | null } | null | undefined,
): number {
  return user?.day_start_hour ?? 0;
}

/**
 * Which working day each of one person's punches belongs to.
 *
 * The single place the rule is applied. Everything that has to agree about
 * "which day is this" - payroll, penalties, overtime, blocked credit, the
 * punch guard, the auto-close - goes through here, because the answer is no
 * longer a pure function of one timestamp and two consumers deriving it
 * separately would put a shift's pay in one month and its lock in another.
 *
 * Callers must pass the punches they already loaded, and must load them wide
 * enough: the rest before an arrival is measured against the previous
 * checkout, so a window that starts mid-shift sees no previous checkout and
 * calls that arrival a new day. Two days either side is what payout already
 * reads for pairing and is more than enough - a 24h gap resets the chain
 * completely.
 */
export function workingDaysOf(punches: PunchLite[], dayStartHour: number): Array<string | null> {
  return assignWorkingDays(punches, {
    restRuleFrom: REST_RULE_FROM,
    // The clock boundary, for anything that happened before the changeover.
    // History keeps the answer it was paid against.
    legacyDayOf: (at) => shiftDateOf(at, dayStartHour),
  });
}

/**
 * The weekday a working day's schedule should be read from.
 *
 * From the LABEL, not from the arrival instant. Under the rest rule a shift
 * that starts at 23:58 can be labelled the following date, and reading the
 * weekday off the punch would then look up a different day's hours than the
 * one the shift is filed under - the schedule and the coverage would disagree
 * about the same day. Noon UTC is always mid-day in Beirut, so no boundary or
 * DST transition can reach it.
 */
export function weekdayOfWorkingDay(date: string): number {
  return beirutWeekday(new Date(`${date}T12:00:00.000Z`));
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
  // The priced pairs behind grossCent, in order. Kept because "what did this
  // day pay" is not the only question asked of a day: revoking overtime asks
  // what the LAST n minutes paid, and that cannot be recovered from a single
  // total once the day spans two rates.
  intervals: WorkInterval[];
}

/** One closed IN/OUT pair, priced at the rate in force when it closed. */
export interface WorkInterval {
  minutes: number;
  rateCent: number;
}

/**
 * Minutes a day is owed with no punch pair behind them, already priced.
 *
 * The only source today is blocked-time credit (blockedCredit.ts): the wait
 * between an employee arriving at the branch and the system finally letting
 * them clock in, which the owner ruled is paid. The minutes are priced by the
 * producer, not here, and the identical objects are handed to computeCoverage
 * and to computePayoutFromRows - that is what keeps a day's grossCent and the
 * month's pairHours gross reconciling to the cent. Two places computing "what
 * is this credit worth" would be two places to get it differently wrong.
 */
export interface CreditedTime {
  date: string; // YYYY-MM-DD (Beirut)
  minutes: number;
  rateCent: number;
}

/** Total minutes in a set of priced intervals. */
export function sumIntervalMinutes(intervals: WorkInterval[]): number {
  return intervals.reduce((s, i) => s + i.minutes, 0);
}

/**
 * What a set of priced intervals is worth, floored per interval.
 *
 * Expressed through centsForLastMinutes on purpose: the day's gross is built
 * by that function, so anything summed this way is priced by the same
 * arithmetic - sum-of-floors, never floor-of-sum - and cannot come out a cent
 * away from the day it is being added to.
 */
export function sumIntervalsCent(intervals: WorkInterval[]): number {
  return centsForLastMinutes(intervals, sumIntervalMinutes(intervals));
}

/**
 * What the last `minutes` worked minutes of a day were paid.
 *
 * Each interval is floored on its own, exactly as payout.ts floors it, and a
 * slice that lands mid-interval is floored too - so slicing a day never
 * produces more than the day. Asking for everything gives the day's gross,
 * which is how grossCent itself is built: one function, so a slice can never
 * disagree with the total it came from.
 */
export function centsForLastMinutes(intervals: WorkInterval[], minutes: number): number {
  let remaining = Math.max(0, minutes);
  let cents = 0;
  for (let i = intervals.length - 1; i >= 0 && remaining > 0; i--) {
    const iv = intervals[i]!;
    const take = Math.min(remaining, iv.minutes);
    cents += Math.floor((take * iv.rateCent) / 60);
    remaining -= take;
  }
  return cents;
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
  // Minutes owed with no punch behind them, already priced by their producer.
  // Folded into workedMin and into the day's intervals, so a day's coverage,
  // its gross and its shortfall all see the same day. Optional because most
  // callers have none, and a caller that omits it gets exactly the old answer.
  credited?: CreditedTime[];
  // The hour the branch's working day starts. 0 - the default, and what every
  // branch has unless the owner changes it - is the calendar day, and
  // shiftDateOf reproduces inBeirut().date exactly there, so omitting this is
  // not merely close to the old behaviour, it is the old behaviour.
  dayStartHour?: number;
}): DayCoverage[] {
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  const workedByDate = new Map<string, number>();
  const dayStart = args.dayStartHour ?? 0;
  const intervalsByDate = new Map<string, WorkInterval[]>();
  const lastPunchByDate = new Map<string, Date>();
  const openDates = new Set<string>();

  // One pass of the rule for this person, and every date below comes out of it.
  // Indexed rather than recomputed per punch because the answer depends on what
  // came before: two shifts can share a calendar date, and only the walk knows
  // which of them already claimed it.
  const labels = workingDaysOf(sorted, dayStart);

  let openIn: PunchLite | null = null;
  let openInAt = -1;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.kind === 'IN') {
      if (!openIn) {
        openIn = p;
        openInAt = i;
      }
      continue;
    }
    if (!openIn) continue; // checkout with no arrival - ignore, as payout does
    const date = labels[openInAt]!;
    const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
    workedByDate.set(date, (workedByDate.get(date) ?? 0) + minutes);
    // The rate is resolved at the SAME instant payout.ts resolves it (the
    // checkout), so summing these across a month reproduces gross exactly.
    const forDate = intervalsByDate.get(date);
    const interval: WorkInterval = { minutes, rateCent: args.rateCentAt(p.at) };
    if (forDate) forDate.push(interval);
    else intervalsByDate.set(date, [interval]);
    lastPunchByDate.set(date, p.at);
    openIn = null;
  }
  if (openIn) {
    const date = labels[openInAt]!;
    openDates.add(date);
    if (!workedByDate.has(date)) workedByDate.set(date, 0);
    lastPunchByDate.set(date, openIn.at);
  }

  // Credited minutes are the front of the day - the employee was already at the
  // branch before the first punch landed - so the interval goes first. Ordering
  // matters to centsForLastMinutes, which slices from the end: "what did the
  // last n minutes pay" must keep answering with real worked minutes.
  //
  // A credit whose date has no punches at all is dropped. Blocked time is the
  // start of a day's work, so a day with no work is a day with nothing to start.
  for (const c of args.credited ?? []) {
    if (c.minutes <= 0) continue;
    if (!workedByDate.has(c.date)) continue;
    workedByDate.set(c.date, (workedByDate.get(c.date) ?? 0) + c.minutes);
    const existing = intervalsByDate.get(c.date);
    const interval: WorkInterval = { minutes: c.minutes, rateCent: c.rateCent };
    if (existing) existing.unshift(interval);
    else intervalsByDate.set(c.date, [interval]);
  }

  const days: DayCoverage[] = [];
  for (const [date, workedMin] of workedByDate) {
    const lastPunchAt = lastPunchByDate.get(date)!;
    const intervals = intervalsByDate.get(date) ?? [];
    const requiredMin = requiredMinFor(
      args.overridesByDate.get(date),
      // From the LABEL, not from the arrival. Under the rest rule a shift that
      // starts at 23:58 can be filed on the following date, and reading the
      // weekday off the punch would look up a different day's hours than the
      // day it is filed under.
      args.shiftMinByWeekday.get(weekdayOfWorkingDay(date)),
    );

    days.push({
      date,
      requiredMin,
      workedMin,
      deltaMin: workedMin - requiredMin,
      closed: !openDates.has(date),
      lastPunchAt,
      grossCent: centsForLastMinutes(intervals, workedMin),
      intervals,
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
export function currentShiftDayMinutes(args: {
  punches: PunchLite[];
  now: Date;
  // Granted blocked-time credit, keyed by Beirut date. Without it this answer
  // and the month's hours disagree on the same screen about the same day: one
  // counts the credited minutes and the other does not.
  creditedMinByDate?: Map<string, number>;
  /** The branch's working-day start hour; 0 is the calendar day. */
  dayStartHour?: number;
}): ShiftDayMinutes {
  const dayStart = args.dayStartHour ?? 0;
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const labels = workingDaysOf(sorted, dayStart);

  const closedByDate = new Map<string, number>();
  let openIn: Date | null = null;
  let openInAt = -1;
  let lastLabel: string | null = null;
  let lastOutAt: Date | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.kind === 'IN') {
      if (!openIn) {
        openIn = p.at;
        openInAt = i;
      }
      continue;
    }
    if (!openIn) continue; // checkout with no arrival - ignore, as payout does
    const date = labels[openInAt]!;
    const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.getTime()) / 60_000));
    closedByDate.set(date, (closedByDate.get(date) ?? 0) + minutes);
    lastLabel = date;
    lastOutAt = p.at;
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

  // Which working day this person is ON right now.
  //
  // Their open arrival's day if they are clocked in. If they are not, a day is
  // still in progress while they might come back: inside the rest window a
  // split shift is not over, and judging it would raise a full day's shortfall
  // at lunchtime that vanishes when they return. Past that window they have
  // gone home, the day is closed, and it may be judged - which is the same rule
  // the day itself is built on rather than a second definition of "over".
  //
  // Empty string means no day in progress. It matches no real date, so a caller
  // comparing against it simply judges everything - which is what "nothing is
  // unfinished" should mean.
  const restedMin = lastOutAt === null ? Infinity : (args.now.getTime() - lastOutAt.getTime()) / 60_000;
  const date = live !== null
    ? labels[openInAt]!
    : restedMin < SHIFT_GAP_MIN && lastLabel !== null
      ? lastLabel
      : '';
  const openMin = live ? openMinRaw : 0;
  return {
    date,
    minutes: (closedByDate.get(date) ?? 0) + openMin + (args.creditedMinByDate?.get(date) ?? 0),
    openInAt: live,
    staleOpenInAt: stale ? openIn : null,
  };
}
