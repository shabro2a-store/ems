import type { PrismaClient } from '@prisma/client';
import { shiftDateOf, scheduledToUtc, inBeirut, SHIFT_GAP_MIN } from 'time';
import { penaltiesForUser, sumActivePenaltiesCent } from './penalty';
import { overtimeDeductionForUser } from './overtime';
import { blockedCreditForUser, grantedIntervals } from './blockedCredit';
import { sumIntervalMinutes, sumIntervalsCent, type WorkInterval, type PunchLite, dayStartHourFor, workingDaysOf, currentShiftDayMinutes } from './coverage';

export interface PayoutForUserResult {
  hours: number;
  grossCent: number;
  // The part of grossCent that is accepted blocked-time credit rather than
  // clocked work. A memo line, not an addend: gross already contains it. The
  // codebase set this standard with overtime_deduction_cent - a figure that
  // moves the total and appears nowhere makes the table stop adding up, and
  // this one silently inflates hours as well as money.
  blockedCreditCent: number;
  blockedCreditMin: number;
  adjustmentsCent: number;
  advancesCent: number;
  penaltiesCent: number;
  overtimeDeductionCent: number;
  // Drivers only. Completed trips this month and what they paid, each priced at
  // the per-trip rate in force when it went out. INSIDE grossCent, the same way
  // blocked credit is: gross is what the month earned, and for a driver that is
  // the hours and the trips together. A memo line, not an addend - the payslip
  // shows it beside gross so a figure that includes deliveries says so, and
  // adding it again would pay every trip twice. Zero for everyone else.
  tripsCount: number;
  tripsCent: number;
  // Trips the owner denied at review this month: unpaid, and shown so the
  // driver knows why the count is short.
  tripsDenied: number;
  netCent: number;
}

interface PunchRow {
  id: string;
  user_id: string;
  kind: 'IN' | 'OUT';
  at: Date;
}

interface RateChangeRow {
  user_id: string;
  rate_cent: number;
  effective_from: Date;
}

interface AdjustmentRow {
  user_id: string;
  kind: 'BONUS' | 'DEDUCTION';
  amount_cent: number;
}

interface AdvanceRow {
  user_id: string;
  amount_cent: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

/**
 * How far either side of the month punches must be loaded before pairing.
 *
 * A shift belongs to the Beirut day it checked IN, which means the pair that
 * decides the last night of the month has its checkout in the NEXT month, and
 * the first night of the month has its arrival in the previous one. Querying
 * the month alone hands `pairHours` an arrival with no checkout at one end and
 * a checkout with no arrival at the other, and it drops both - so a night shift
 * across the boundary was paid nothing, in either month. Not misfiled: lost.
 *
 * Two days is far past MAX_OPEN_SESSION_MIN (30h), which is the longest a
 * session can be before the system closes it, so no real pair reaches outside
 * this window.
 */
export const PAIR_LOOKAROUND_MS = 2 * 86_400_000;

/**
 * The UTC calendar month.
 *
 * Correct for the date-keyed rows that use it - ScheduleOverride.date, penalty
 * and credit dates are all stored as a Beirut date pinned to UTC midnight, so a
 * UTC month selects exactly the right ones. It is NOT the window to pair
 * punches in; see PAIR_LOOKAROUND_MS and pairHours.
 */
export function monthRangeUtc(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`invalid month format: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) throw new Error(`invalid month: ${month}`);
  const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, mon, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * The month in BEIRUT instants, for rows stamped with a real moment.
 *
 * monthRangeUtc is right for the date-keyed columns - an override, a penalty
 * date, an adjustment period are all a Beirut date pinned to UTC midnight, so a
 * UTC month selects exactly the right ones. It is wrong for anything stamped
 * with `now()`: Beirut is UTC+2/+3, so the UTC month does not begin until 02:00
 * or 03:00 local on the 1st, and an advance approved at 01:00 that morning fell
 * into the month that had just closed - and been paid.
 *
 * The 1st is never a DST day (Lebanon switches on the last Sunday of March and
 * October), so Beirut midnight always exists for these two instants.
 */
export function monthRangeBeirut(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`invalid month format: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) throw new Error(`invalid month: ${month}`);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start: scheduledToUtc(`${year}-${pad(mon)}-01`, '00:00'),
    end: scheduledToUtc(`${nextYear}-${pad(nextMon)}-01`, '00:00'),
  };
}

export function rateAt(rateChanges: { rate_cent: number; effective_from: Date }[], at: Date): number {
  for (let i = rateChanges.length - 1; i >= 0; i--) {
    const rc = rateChanges[i]!;
    if (rc.effective_from <= at) return rc.rate_cent;
  }
  return 0;
}

/**
 * Pair IN/OUT and price each pair, keeping only the pairs that belong to
 * `month` - which is decided by the Beirut day of the ARRIVAL, never by the
 * timestamp of either punch.
 *
 * That rule is the same one coverage.ts, the penalty engine and the auto-close
 * all use, and applying it here is what makes a 21:00-07:00 shift on the last
 * night of the month land whole in the month it started, instead of being
 * split down the middle by the boundary and dropped by both sides.
 *
 * With `month` omitted every pair counts, which is what the day-level callers
 * and the property tests want.
 */
function pairHours(
  punches: PunchRow[],
  rateChanges: RateChangeRow[],
  month?: string,
  dayStartHour = 0,
): { minutes: number; grossCent: number } {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  // The same one pass computeCoverage makes, so a month's gross and the sum of
  // its days cannot land on different answers about which day a shift is.
  const labels = workingDaysOf(sorted as PunchLite[], dayStartHour);
  let totalMinutes = 0;
  let grossCent = 0;
  let openIn: PunchRow | null = null;
  let openInAt = -1;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.kind === 'IN') {
      if (!openIn) {
        openIn = p;
        openInAt = i;
      }
    } else {
      if (openIn) {
        // The arrival's working day, so an overnight pair is counted once, in
        // the month it began. A checkout at 07:00 on the 1st does not move it.
        const belongs = month === undefined || (labels[openInAt] ?? '').slice(0, 7) === month;
        if (belongs) {
          const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
          totalMinutes += minutes;
          const rateCent = rateAt(rateChanges, p.at);
          grossCent += Math.floor((minutes * rateCent) / 60);
        }
        openIn = null;
      }
    }
  }
  return { minutes: totalMinutes, grossCent };
}

export interface TripRow {
  out_at: Date;
  back_at: Date | null;
  // Set when the owner looked at the receipt photo and said no (tripReview.ts).
  // A denied trip is not a trip anywhere money or counts are concerned.
  // Optional so a caller with older rows in hand still compiles; absent means
  // not denied.
  denied_at?: Date | null;
}

/**
 * Which working day a trip belongs to: the one of the SHIFT it happened in.
 *
 * Not the calendar date it went out on. The same rest rule that files the
 * punches files the trip, so a driver's hours and deliveries can never land on
 * different days - or in different months. A trip at 00:30 during a shift that
 * started the night before is that shift's trip; a trip during the break
 * between two chunks of one working day is still that day's. That is the
 * whole reason the rule exists, and the reason it was wrong to have trips
 * follow a different one from the hours beside them.
 *
 * Concretely: the label of the most recent arrival at or before the trip,
 * while that working day is still in progress - the session is open, or the
 * last checkout was inside the rest window. Past the rest window the driver
 * has gone home, and a trip with no shift around it (which the trip guard now
 * refuses, but history holds a few) falls back to the day it happened on.
 */
export function workingDayOfTrip(
  outAt: Date,
  sortedPunches: PunchLite[],
  labels: Array<string | null>,
): string {
  let lastLabel: string | null = null;
  let lastOutAt: Date | null = null;
  let open = false;
  for (let i = 0; i < sortedPunches.length; i++) {
    const p = sortedPunches[i]!;
    if (p.at > outAt) break;
    if (p.kind === 'IN') {
      if (labels[i] !== null) lastLabel = labels[i];
      open = true;
    } else {
      open = false;
      lastOutAt = p.at;
    }
  }
  if (lastLabel === null) return inBeirut(outAt).date;
  if (open) return lastLabel;
  if (lastOutAt !== null && (outAt.getTime() - lastOutAt.getTime()) / 60_000 < SHIFT_GAP_MIN) return lastLabel;
  return inBeirut(outAt).date;
}

/**
 * How many trips a driver completed in `month`, and what they earned for them.
 *
 * A trip counts when it has a BACK - a driver still out has not finished the
 * delivery, and the trip-close sweep writes a BACK for one who forgot, so an
 * abandoned trip still pays once it is closed.
 *
 * Each trip is priced at the rate in force when it went out, the way an hour is
 * priced at the rate in force when it was clocked out, so a mid-month change
 * to the per-trip rate reprices nothing that already happened. Which month it
 * belongs to is `dayOf`, which callers build from the punches so it agrees
 * with the hours; the default is the day it happened on, for a caller with no
 * punches in hand.
 */
export function tripPay(
  trips: TripRow[],
  tripRateChanges: { rate_cent: number; effective_from: Date }[],
  month?: string,
  dayOf: (outAt: Date) => string = (outAt) => inBeirut(outAt).date,
): { count: number; cent: number; denied: number } {
  let count = 0;
  let cent = 0;
  let denied = 0;
  for (const t of trips) {
    if (t.back_at === null) continue;
    if (month !== undefined && dayOf(t.out_at).slice(0, 7) !== month) continue;
    // Denied by the owner at review: pays nothing, and the payslip says so -
    // a driver paid for eleven of twelve deliveries should know which one.
    if (t.denied_at) {
      denied += 1;
      continue;
    }
    count += 1;
    cent += rateAt(tripRateChanges, t.out_at);
  }
  return { count, cent, denied };
}

/** The `dayOf` a caller with the punches in hand should pass to tripPay. */
export function tripDayResolver(punches: PunchLite[], dayStartHour: number): (outAt: Date) => string {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const labels = workingDaysOf(sorted, dayStartHour);
  return (outAt) => workingDayOfTrip(outAt, sorted, labels);
}

/**
 * How many trips a driver has made on the working day they are ON right now.
 *
 * The same day currentShiftDayMinutes reports hours for, and the same rule
 * that files a trip for payroll - so the caller's board, the admin dashboard
 * and the payslip all agree about which trips are "today's". There used to be
 * three different answers: trips since the current clock-in (which reset every
 * time a chunk worker came back from a break), and trips inside the calendar
 * day (which cut a night shift in half at midnight), beside an hours figure on
 * the same row that already followed the working day.
 *
 * Where the shift belongs, its trips belong. If the driver's return continued
 * the same working day, the count continues; if it opened a new one, the count
 * starts again and everything before it is the previous day's. A driver who
 * has gone home has no day in progress and no trips today.
 */
export function tripsOnCurrentWorkingDay(args: {
  punches: PunchLite[];
  trips: TripRow[];
  now: Date;
  dayStartHour?: number;
}): { date: string; count: number } {
  const dayStart = args.dayStartHour ?? 0;
  const { date } = currentShiftDayMinutes({ punches: args.punches, now: args.now, dayStartHour: dayStart });
  if (date === '') return { date, count: 0 };
  const dayOf = tripDayResolver(args.punches, dayStart);
  let count = 0;
  for (const t of args.trips) {
    if (t.out_at > args.now) continue;
    if (t.denied_at) continue;
    if (dayOf(t.out_at) === date) count += 1;
  }
  return { date, count };
}

/**
 * Worked minutes plus any credited minutes, priced the same way.
 *
 * The credited intervals are the very objects computeCoverage folded into
 * those days, produced once by blockedCredit.ts, and they are summed here by
 * the same per-interval floor coverage prices them with. That is what keeps
 * this month total equal to the sum of each day's grossCent: one pairing, one
 * flooring, one rate instant, and one set of credit figures - never two
 * implementations that have to be kept agreeing by hand.
 */
function grossWithCredit(
  punches: PunchRow[],
  rateChanges: RateChangeRow[],
  creditedIntervals: WorkInterval[],
  month?: string,
  dayStartHour = 0,
): { hours: number; grossCent: number } {
  const paired = pairHours(punches, rateChanges, month, dayStartHour);
  const minutes = paired.minutes + sumIntervalMinutes(creditedIntervals);
  return {
    hours: Math.round((minutes / 60) * 100) / 100,
    grossCent: paired.grossCent + sumIntervalsCent(creditedIntervals),
  };
}

export function computePayoutFromRows(args: {
  userId: string;
  punches: PunchRow[];
  rateChanges: RateChangeRow[];
  adjustments: AdjustmentRow[];
  approvedAdvances: AdvanceRow[];
  penaltiesCent?: number;
  overtimeDeductionCent?: number;
  // Blocked-time credit, already priced, exactly as computeCoverage received
  // it. Paid time with no punch behind it, so it belongs in gross rather than
  // in adjustments: it is hours worked, and the day's own gross already counts
  // it - the two would disagree otherwise, and the penalty ceiling is clamped
  // to that per-day figure.
  creditedIntervals?: WorkInterval[];
  // A driver's trips and the per-trip rate history that prices them. Both
  // optional: everybody who is not a driver has neither, and gets zero.
  trips?: TripRow[];
  tripRateChanges?: { rate_cent: number; effective_from: Date }[];
  // The month these punches are being paid for, 'YYYY-MM'. Given it, a pair is
  // counted only if its ARRIVAL falls in that Beirut month - which is what
  // stops the night across the boundary being counted twice, or (as it was)
  // zero times. Omit it and every pair counts.
  month?: string;
  /** The branch's working-day start hour; 0 is the calendar day. */
  dayStartHour?: number;
}): PayoutForUserResult {
  const adjustmentsCent = args.adjustments.reduce((s, a) => {
    return s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent);
  }, 0);
  const advancesCent = args.approvedAdvances
    .filter((a) => a.status === 'APPROVED')
    .reduce((s, a) => s + a.amount_cent, 0);
  const penaltiesCent = args.penaltiesCent ?? 0;
  const overtimeDeductionCent = args.overtimeDeductionCent ?? 0;
  const credited = args.creditedIntervals ?? [];
  const { hours, grossCent } = grossWithCredit(
    args.punches,
    args.rateChanges,
    credited,
    args.month,
    args.dayStartHour,
  );
  const trips = tripPay(
    args.trips ?? [],
    args.tripRateChanges ?? [],
    args.month,
    tripDayResolver(args.punches as PunchLite[], args.dayStartHour ?? 0),
  );
  // Trips are earnings, so they are gross. Net does not add them again.
  const grossWithTrips = grossCent + trips.cent;
  const netCent = grossWithTrips + adjustmentsCent - advancesCent - penaltiesCent - overtimeDeductionCent;
  return {
    hours,
    grossCent: grossWithTrips,
    blockedCreditCent: sumIntervalsCent(credited),
    blockedCreditMin: sumIntervalMinutes(credited),
    adjustmentsCent,
    advancesCent,
    penaltiesCent,
    overtimeDeductionCent,
    tripsCount: trips.count,
    tripsCent: trips.cent,
    tripsDenied: trips.denied,
    netCent,
  };
}

export async function payoutForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<PayoutForUserResult> {
  const { start, end } = monthRangeUtc(month);
  // Punches are read wider than the month and then filtered by arrival month
  // inside pairHours; every other row here is date-keyed and takes the month
  // window as-is.
  const pairFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const pairTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const { start: beirutStart, end: beirutEnd } = monthRangeBeirut(month);
  const [punches, rateChanges, adjustments, approvedAdvances, penalties, overtimeDeductionCent, credits, user] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: pairFrom, lt: pairTo } },
      orderBy: { at: 'asc' },
      select: { id: true, user_id: true, kind: true, at: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    db.adjustment.findMany({
      where: { user_id: userId, period: { gte: start, lt: end } },
      select: { user_id: true, kind: true, amount_cent: true },
    }),
    db.advance.findMany({
      // Beirut bounds: created_at is a real instant, not a date marker.
      where: { user_id: userId, status: 'APPROVED', created_at: { gte: beirutStart, lt: beirutEnd } },
      select: { user_id: true, amount_cent: true, status: true },
    }),
    penaltiesForUser(userId, month, db),
    overtimeDeductionForUser(userId, month, db),
    blockedCreditForUser(userId, month, db),
    db.user.findUnique({
      where: { id: userId },
      select: { day_start_hour: true, role: true },
    }),
  ]);
  // A driver's trips, read on the same widened window as the punches and then
  // filed by the shift they happened in - a trip at 00:30 on the 1st during a
  // shift that started the night before is the previous month's, and a query
  // on the calendar month would never see it. Only for drivers: the query is
  // not free and everybody else's answer is zero by definition.
  const isDriver = user?.role === 'DRIVER';
  const [trips, tripRateChanges] = isDriver
    ? await Promise.all([
        db.trip.findMany({
          where: { driver_id: userId, out_at: { gte: pairFrom, lt: pairTo } },
          select: { out_at: true, back_at: true, denied_at: true },
        }),
        db.tripRateChange.findMany({
          where: { user_id: userId, effective_from: { lt: end } },
          orderBy: { effective_from: 'asc' },
          select: { user_id: true, rate_cent: true, effective_from: true },
        }),
      ])
    : [[], []];
  return computePayoutFromRows({
    userId,
    punches: punches as PunchRow[],
    rateChanges: rateChanges as RateChangeRow[],
    adjustments: adjustments as AdjustmentRow[],
    approvedAdvances: approvedAdvances as AdvanceRow[],
    penaltiesCent: sumActivePenaltiesCent(penalties),
    overtimeDeductionCent,
    creditedIntervals: grantedIntervals(credits),
    trips,
    tripRateChanges: tripRateChanges as RateChangeRow[],
    month,
    dayStartHour: dayStartHourFor(user),
  });
}

export async function accruedEarningsThisMonth(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<{ hours: number; grossCent: number }> {
  const { start, end } = monthRangeUtc(month);
  const pairFrom = new Date(start.getTime() - PAIR_LOOKAROUND_MS);
  const pairTo = new Date(end.getTime() + PAIR_LOOKAROUND_MS);
  const [punches, rateChanges, credits, user] = await Promise.all([
    db.punch.findMany({
      where: { user_id: userId, at: { gte: pairFrom, lt: pairTo } },
      orderBy: { at: 'asc' },
      select: { id: true, user_id: true, kind: true, at: true },
    }),
    db.rateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
    // The advance cap is "everything earned this month", and blocked-time
    // credit is earned - leaving it out would lend against a smaller month
    // than payroll is about to pay.
    blockedCreditForUser(userId, month, db),
    db.user.findUnique({
      where: { id: userId },
      select: { day_start_hour: true, role: true },
    }),
  ]);
  const earned = grossWithCredit(
    punches as PunchRow[],
    rateChanges as RateChangeRow[],
    grantedIntervals(credits),
    month,
    dayStartHourFor(user),
  );
  // A driver's trips are earned too, for the same reason blocked credit is:
  // the cap has to be the month payroll is about to pay, or it lends against
  // less than they are owed.
  if (user?.role !== 'DRIVER') return earned;
  const [trips, tripRates] = await Promise.all([
    db.trip.findMany({
      where: { driver_id: userId, out_at: { gte: pairFrom, lt: pairTo } },
      select: { out_at: true, back_at: true, denied_at: true },
    }),
    db.tripRateChange.findMany({
      where: { user_id: userId, effective_from: { lt: end } },
      orderBy: { effective_from: 'asc' },
      select: { user_id: true, rate_cent: true, effective_from: true },
    }),
  ]);
  const tripsCent = tripPay(
    trips,
    tripRates,
    month,
    tripDayResolver(punches as PunchLite[], dayStartHourFor(user)),
  ).cent;
  return { hours: earned.hours, grossCent: earned.grossCent + tripsCent };
}

export interface RosterUser {
  id: string;
  username: string;
  name: string | null;
  role: string;
  branch_id: string | null;
  hourly_rate_cent: number;
  expected_monthly_salary_cent: number | null;
  deleted_at: Date | null;
  branch: { name: string } | null;
}

/**
 * Who belongs on a month's payroll.
 *
 * Not "everybody active", which is what this used to be and which quietly lost
 * people: deactivate somebody in January and January's payroll stopped listing
 * them, so the month you still owed them for went blank on the screen while
 * their punches sat untouched in the database.
 *
 * Two groups, and the second is the point:
 *
 *  - everybody currently on the staff, so a person who did nothing this month
 *    still shows as a zero row rather than silently vanishing
 *  - anybody at all - deactivated, or retired and gone from every other screen -
 *    who STARTED a shift in this Beirut month
 *
 * That is what makes a retired account behave the way the owner described. The
 * month they worked still lists them, because they have arrivals in it. The
 * month after does not, because they have none - no job sweeps them up and
 * nothing expires; they are simply absent from a query about a month they were
 * not there for.
 *
 * Membership is decided by the ARRIVAL's Beirut month, the same rule pairHours
 * pays by, so the roster and the money can never disagree about which month
 * somebody belongs to - including the night that starts on the 31st.
 */
export async function payrollRoster(
  db: PrismaClient,
  month: string,
  branchId: string | null,
): Promise<RosterUser[]> {
  const { start, end } = monthRangeUtc(month);
  const arrivals = await db.punch.findMany({
    where: {
      kind: 'IN',
      at: {
        gte: new Date(start.getTime() - PAIR_LOOKAROUND_MS),
        lt: new Date(end.getTime() + PAIR_LOOKAROUND_MS),
      },
    },
    select: { user_id: true, at: true },
  });
  // Membership uses each user's own branch boundary, so a night shift that a
  // 6am branch calls the 31st is in that month here too.
  const hourByUser = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(arrivals.map((a) => a.user_id))] } },
        select: { id: true, day_start_hour: true },
      })
    ).map((u) => [u.id, dayStartHourFor(u)]),
  );
  // Who to build a payslip for. Deliberately WIDE: an arrival counts if either
  // the calendar month or the old boundary's month matches, because this is
  // only a list of candidates and each one's payout is computed properly
  // afterwards. Resolving the exact working day here would mean pulling every
  // candidate's surrounding punches to answer a question whose wrong answers
  // are not symmetric - including somebody who worked nothing shows a payslip
  // of zero, while excluding somebody drops a month of their pay off the screen
  // entirely.
  const workedIds = [
    ...new Set(
      arrivals
        .filter((a) => {
          const hour = hourByUser.get(a.user_id) ?? 0;
          return (
            inBeirut(a.at).date.slice(0, 7) === month ||
            shiftDateOf(a.at, hour).slice(0, 7) === month
          );
        })
        .map((a) => a.user_id),
    ),
  ];

  return db.user.findMany({
    where: {
      role: { in: ['EMPLOYEE', 'DRIVER'] },
      ...(branchId ? { branch_id: branchId } : {}),
      OR: [{ is_active: true, deleted_at: null }, { id: { in: workedIds } }],
    },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      branch_id: true,
      hourly_rate_cent: true,
      expected_monthly_salary_cent: true,
      deleted_at: true,
      branch: { select: { name: true } },
    },
    orderBy: [{ branch: { name: 'asc' } }, { username: 'asc' }],
  });
}
