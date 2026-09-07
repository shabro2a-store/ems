import { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } from 'date-fns-tz';

export const SHOP_TZ = 'Asia/Beirut';

export function inBeirut(d: Date): { date: string; hhmm: string } {
  const zoned = utcToZonedTime(d, SHOP_TZ);
  return {
    date: formatInTimeZone(d, SHOP_TZ, 'yyyy-MM-dd'),
    hhmm: formatInTimeZone(d, SHOP_TZ, 'HH:mm'),
  };
}

export function todayInBeirut(now: Date = new Date()): string {
  return inBeirut(now).date;
}

export function beirutWeekday(now: Date = new Date()): number {
  const iso = Number(formatInTimeZone(now, SHOP_TZ, 'i'));
  return iso === 7 ? 0 : iso;
}

export function scheduledToUtc(date: string, hhmm: string): Date {
  return zonedTimeToUtc(`${date} ${hhmm}`, SHOP_TZ);
}

/** The calendar date `offset` days from this one. Never arithmetic on an
 * instant: a Beirut day is 23 or 25 hours long twice a year, so "+/-24h" names
 * the wrong date on the days either side of a transition. */
function shiftCalendarDate(date: string, offset: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y as number, (m as number) - 1, (d as number) + offset);
  if (Number.isNaN(t)) return date; // malformed input - same garbage in, garbage out as before
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The Beirut calendar date before this one. Anything judging "the day that just
 * ended" must ask the calendar: subtracting 24 hours from an instant lands on
 * the wrong date the morning after a short DST day, which silently skips it.
 */
export function previousBeirutDate(date: string): string {
  return shiftCalendarDate(date, -1);
}

/**
 * The first instant belonging to the given Beirut calendar date.
 *
 * Usually local midnight. On the spring-forward day it is not: Beirut jumps
 * 00:00 -> 01:00, so midnight never happens and zonedTimeToUtc answers with an
 * instant that still belongs to the previous date. Stepping forward to the
 * first minute that really lands on the date finds the transition itself,
 * which is where the day begins. The loop only ever runs one day a year and
 * exits within the length of the gap.
 */
function beirutDayStart(date: string): Date {
  const midnight = zonedTimeToUtc(`${date} 00:00:00`, SHOP_TZ);
  if (Number.isNaN(midnight.getTime())) return midnight;
  if (formatInTimeZone(midnight, SHOP_TZ, 'yyyy-MM-dd') === date) return midnight;
  for (let minutes = 1; minutes <= 24 * 60; minutes++) {
    const t = new Date(midnight.getTime() + minutes * 60_000);
    if (formatInTimeZone(t, SHOP_TZ, 'yyyy-MM-dd') === date) return t;
  }
  return midnight;
}

/**
 * Returns the UTC [start, end) range for the given Beirut-local day: from the
 * first instant of that date to the first instant of the next.
 *
 * Both ends are resolved from the calendar date, never by adding 24 hours to
 * an instant. Doing the latter broke on both Beirut DST days: on the 25-hour
 * fall-back day (2026-10-24) start+24h landed back inside the same date and
 * the range collapsed to nothing, and on the day before the spring-forward
 * (2026-03-28) it lost the last local hour. Every caller windows punches with
 * this, so an empty range reads as "nobody worked".
 */
export function todayInBeirutDateRange(date: string): { startUtc: Date; endUtc: Date } {
  return { startUtc: beirutDayStart(date), endUtc: beirutDayStart(shiftCalendarDate(date, 1)) };
}
/**
 * The UTC [start, end) range of one working day, when the day does not begin at
 * midnight. The inverse of shiftDateOf: every instant in this range answers
 * `date` from that function, and no instant outside it does.
 *
 * `dayStartHour` 0 delegates to todayInBeirutDateRange, so it is the calendar
 * day exactly - DST handling included, rather than reimplemented beside it.
 * Above 0 the hour is unambiguous by construction: Beirut moves its clocks at
 * midnight, so 01:00 and later exist exactly once on every date of the year.
 */
export function shiftDayRange(date: string, dayStartHour = 0): { startUtc: Date; endUtc: Date } {
  if (dayStartHour <= 0) return todayInBeirutDateRange(date);
  const hhmm = `${String(dayStartHour).padStart(2, '0')}:00:00`;
  return {
    startUtc: scheduledToUtc(date, hhmm),
    endUtc: scheduledToUtc(shiftCalendarDate(date, 1), hhmm),
  };
}

/**
 * The working day a moment belongs to, when the day does not begin at midnight.
 *
 * Some shifts sit ON the midnight line. Dani starts at 23:00 some nights and
 * 00:00 others and finishes at 07:00 either way: one shift, but the calendar
 * puts the two starts on different dates, so one night landed a second shift on
 * a day that already had one - 968 minutes against 8 owed, reported as eight
 * hours of overtime - and left the next day with nothing, looking like an
 * absence. Two minutes decided which.
 *
 * Moving the boundary to an hour when nobody is starting a shift fixes it
 * without touching the rule everything else is built on: a shift still belongs
 * to the day it clocked IN, that day just runs 06:00 to 06:00 rather than
 * 00:00 to 00:00. Both of dani's starts then name the same day, while the
 * handover at 07:00 and every day shift are on the ordinary side of it.
 *
 * `dayStartHour` 0 is the calendar day, and this is then EXACTLY inBeirut().date
 * - the same string, by construction, not merely usually. That is what lets the
 * setting default to 0 and change nothing anywhere until a branch opts in.
 */
export function shiftDateOf(at: Date, dayStartHour = 0): string {
  const { date, hhmm } = inBeirut(at);
  if (dayStartHour <= 0) return date;
  return Number(hhmm.slice(0, 2)) >= dayStartHour ? date : previousBeirutDate(date);
}

/**
 * The weekday of the working day a moment belongs to - which is what decides
 * the hours it owes, so it has to move with shiftDateOf or a night shift would
 * be measured against the wrong day's schedule.
 *
 * Resolved from the shift DATE rather than the instant: noon on that date is
 * inside it in Beirut on every day of the year, including both DST days, where
 * midnight is either ambiguous or does not exist.
 */
export function shiftWeekdayOf(at: Date, dayStartHour = 0): number {
  if (dayStartHour <= 0) return beirutWeekday(at);
  return beirutWeekday(new Date(`${shiftDateOf(at, dayStartHour)}T12:00:00.000Z`));
}

/**
 * The rest that separates one working day from the next.
 *
 * 4h15m, and it is measured, not chosen. Across 120 days of this shop's
 * punches the two populations do not overlap:
 *
 *   longest break inside one working day   2h58m  (out 05:48, back 08:46)
 *   shortest rest between working days     5h32m  (out 18:21, back 23:53)
 *
 * 255 minutes is the exact midpoint, leaving about eighty minutes of slack on
 * each side. The ceiling is set by a 17-hour worker, who is only ever home
 * 6h54m, and the floor by staff who split a day around a long afternoon; the
 * owner confirmed the 5½-hour turnarounds are people going home to sleep
 * before an opening shift, not a break.
 *
 * Widen it and two shifts merge into a 34-hour day - phantom overtime, and a
 * day displaced across a month boundary. Narrow it and a split shift becomes
 * two days, each judged short and each docked.
 */
export const SHIFT_GAP_MIN = 255;

/**
 * The instant the rest rule takes over. Arrivals before it keep whatever the
 * clock boundary said; arrivals from it on are decided by rest.
 *
 * History is not rewritten, and that is the whole point of having a cutover at
 * all. Attribution is recomputed from the punches every time anybody opens
 * payroll, so changing the rule outright would silently move every shift ever
 * worked - including across month boundaries that have already been paid. One
 * employee needed a manual top-up when a single shift moved; eleven at once is
 * not a reconciliation anybody should be asked to do.
 *
 * A shift is decided by its ARRIVAL, so one in progress across this instant
 * keeps its old label whole rather than being cut in half.
 */
export const REST_RULE_FROM = new Date('2026-09-08T00:00:00+03:00');

/**
 * Which working day each punch belongs to, decided by REST rather than by a
 * clock hour.
 *
 * The clock-hour version could not work, and the reason is worth keeping. A
 * boundary at 04:00 asks "is this before 4am?", which answers a different
 * question from the one that matters - it files a day worker's single 00:24
 * start under the previous day, and it cannot separate two shifts that both
 * begin in the evening. Rest can do both: the gap since the last checkout says
 * whether somebody went home, and going home is what ends a working day.
 *
 * Returns one label per punch, aligned to the input array. A checkout takes the
 * label of the shift it closes; an orphan checkout with no arrival gets null,
 * as every other reader already ignores those.
 *
 * The collision rule is what unpicks a night worker. Give a new working day the
 * Beirut calendar date of its check-in, unless an earlier working day has
 * already claimed that date - then take the next free one. dani starting at
 * 00:02 on Wednesday takes Wednesday; when he starts again at 23:58 that same
 * Wednesday, Wednesday is gone and he becomes Thursday. Four consecutive nights
 * come out as four consecutive days, which is what the schedule and the payroll
 * month both need, and no hour of the clock appears anywhere in it.
 */
export interface WorkingDayOpts {
  /** Rest that separates two working days. Defaults to SHIFT_GAP_MIN. */
  gapMin?: number;
  /**
   * Arrivals before this keep the answer `legacyDayOf` gives. Omit to decide
   * everything by rest, which is what the rule looks like once the changeover
   * is behind us and what the pure tests exercise.
   */
  restRuleFrom?: Date;
  /**
   * The old rule, for arrivals before the cutover - in practice
   * `(at) => shiftDateOf(at, dayStartHour)`. Required with restRuleFrom,
   * because a caller that guessed midnight here would rewrite exactly the
   * night-worker history the cutover exists to leave alone.
   */
  legacyDayOf?: (at: Date) => string;
}

export function assignWorkingDays(
  punches: Array<{ kind: 'IN' | 'OUT'; at: Date }>,
  opts: WorkingDayOpts | number = {},
): Array<string | null> {
  const o: WorkingDayOpts = typeof opts === 'number' ? { gapMin: opts } : opts;
  const gapMin = o.gapMin ?? SHIFT_GAP_MIN;
  const cutover = o.restRuleFrom ?? null;
  const legacyDayOf = o.legacyDayOf ?? null;
  const order = punches
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.at.getTime() - b.p.at.getTime() || a.i - b.i);

  const labels: Array<string | null> = new Array(punches.length).fill(null);
  const claimed = new Set<string>();
  let currentDay: string | null = null;
  let lastOutAt: Date | null = null;
  let openSince: Date | null = null;

  for (const { p, i } of order) {
    if (p.kind === 'OUT') {
      // A checkout belongs to whatever shift it closes. One with no arrival
      // before it names nothing, and is dropped by every consumer already.
      labels[i] = currentDay;
      if (currentDay !== null) {
        lastOutAt = p.at;
        openSince = null;
      }
      continue;
    }

    // A second arrival while one is still open is a duplicate tap, not a shift.
    // The advisory lock makes new ones impossible, but the history holds plenty
    // - four in eight minutes on one night - and they must not each open a day.
    if (openSince !== null) {
      labels[i] = currentDay;
      continue;
    }

    // Before the cutover, answer exactly as the old rule did - and claim that
    // date, so a later shift decided by rest still sees it as taken.
    if (cutover !== null && legacyDayOf !== null && p.at < cutover) {
      const legacy = legacyDayOf(p.at);
      claimed.add(legacy);
      currentDay = legacy;
      labels[i] = legacy;
      openSince = p.at;
      continue;
    }

    const restMin = lastOutAt === null ? Infinity : (p.at.getTime() - lastOutAt.getTime()) / 60_000;
    if (currentDay !== null && restMin < gapMin) {
      labels[i] = currentDay; // they never went home: same working day
    } else {
      let date = inBeirut(p.at).date;
      while (claimed.has(date)) date = shiftCalendarDate(date, 1);
      claimed.add(date);
      currentDay = date;
      labels[i] = date;
    }
    openSince = p.at;
  }

  return labels;
}
