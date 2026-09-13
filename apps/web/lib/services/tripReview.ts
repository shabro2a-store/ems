import type { PrismaClient } from '@prisma/client';
import { todayInBeirutDateRange } from 'time';
import { isMonthOpen } from './periodLock';
import { tripDayResolver, PAIR_LOOKAROUND_MS } from './payout';
import { dayStartHourFor, type PunchLite } from './coverage';

/**
 * The owner's review of a driver's deliveries, one working day at a time.
 *
 * Every trip starts with a live photo of the order's receipt (see startTrip),
 * and at the end of the shift the owner looks at that day's photos beside the
 * cash the driver handed the register: the manager counts the money, the owner
 * confirms the orders. A photo of something that is not that day's receipt is
 * DENIED, and a denied trip pays nothing. Everything else is paid - denial is
 * the exception, not confirmation the rule - so a shift the owner never gets
 * to costs the driver none of their deliveries.
 *
 * Once the owner presses "confirm" the day is settled and nothing on it can
 * change. If he does not, it settles itself REVIEW_WINDOW_MIN after the day's
 * last trip went out: paid as it stands, locked. The month's payroll closing
 * locks it too, whatever the clock says - a ruling after that would change a
 * figure that is being paid.
 */
export const REVIEW_WINDOW_MIN = 48 * 60;

export interface ReviewableTrip {
  out_at: Date;
  reviewed_at: Date | null;
  denied_at: Date | null;
}

/**
 * The moment a day's review closes on its own: REVIEW_WINDOW_MIN after its
 * LAST trip went out. The day, not the trip: the owner reviews a shift as a
 * unit, so its first delivery waits for its last.
 */
export function reviewDeadline(trips: { out_at: Date }[]): Date | null {
  if (trips.length === 0) return null;
  const last = Math.max(...trips.map((t) => t.out_at.getTime()));
  return new Date(last + REVIEW_WINDOW_MIN * 60_000);
}

export type DayReviewState = 'empty' | 'open' | 'confirmed' | 'expired' | 'month_closed';

/**
 * Confirmed beats the clock: a day the owner settled stays settled. A day with
 * a trip he has NOT looked at - one made after he confirmed, with the driver
 * still on shift - is open again for that trip; the ones he confirmed stay
 * locked individually (tripLocked).
 */
export function dayReviewState(args: { date: string; trips: ReviewableTrip[]; now: Date }): DayReviewState {
  if (args.trips.length === 0) return 'empty';
  if (args.trips.every((t) => t.reviewed_at !== null)) return 'confirmed';
  if (!isMonthOpen(args.date, args.now)) return 'month_closed';
  const deadline = reviewDeadline(args.trips)!;
  if (args.now.getTime() >= deadline.getTime()) return 'expired';
  return 'open';
}

/** Whether a deny or a restore may still touch this trip. */
export function tripLocked(trip: { reviewed_at: Date | null }, dayState: DayReviewState): boolean {
  return trip.reviewed_at !== null || dayState !== 'open';
}

/**
 * Every driver's trips, filed under the working day of the SHIFT each
 * happened in - the same rule payroll files them by (tripDayResolver), so the
 * day the owner confirms is exactly the day the driver is paid for. Insertion
 * order within a day follows the input, so pass trips sorted by out_at.
 */
export function tripsByDriverDay<T extends { driver_id: string; out_at: Date }>(args: {
  trips: T[];
  punchesByDriver: Map<string, PunchLite[]>;
  dayStartHourOf: (driverId: string) => number;
}): Map<string, Map<string, T[]>> {
  const resolvers = new Map<string, (outAt: Date) => string>();
  const out = new Map<string, Map<string, T[]>>();
  for (const t of args.trips) {
    let dayOf = resolvers.get(t.driver_id);
    if (!dayOf) {
      dayOf = tripDayResolver(args.punchesByDriver.get(t.driver_id) ?? [], args.dayStartHourOf(t.driver_id));
      resolvers.set(t.driver_id, dayOf);
    }
    const date = dayOf(t.out_at);
    const days = out.get(t.driver_id) ?? new Map<string, T[]>();
    const list = days.get(date) ?? [];
    list.push(t);
    days.set(date, list);
    out.set(t.driver_id, days);
  }
  return out;
}

// ---- reading the review out of the database ----

/** Everything the review needs of a trip, and never the photo bytes. */
export const REVIEW_TRIP_SELECT = {
  id: true,
  driver_id: true,
  branch_id: true,
  out_at: true,
  back_at: true,
  system_generated: true,
  receipt_taken_at: true,
  denied_at: true,
  denied_reason: true,
  reviewed_at: true,
  branch: { select: { name: true } },
  receipt: { select: { trip_id: true } },
} as const;

export interface ReviewTrip {
  id: string;
  driver_id: string;
  branch_id: string;
  out_at: Date;
  back_at: Date | null;
  system_generated: boolean;
  receipt_taken_at: Date | null;
  denied_at: Date | null;
  denied_reason: string | null;
  reviewed_at: Date | null;
  branch: { name: string };
  receipt: { trip_id: string } | null;
}

export interface ReviewDriver {
  id: string;
  username: string;
  name: string | null;
  branch_id: string | null;
  branch: { name: string } | null;
}

export interface ReviewWindow {
  /** driver id -> working day -> that day's trips, in the order they went out */
  byDriver: Map<string, Map<string, ReviewTrip[]>>;
  drivers: Map<string, ReviewDriver>;
}

/**
 * Every driver's trips filed on working days from `fromDate` to `toDate`
 * inclusive, grouped by driver and day.
 *
 * Read on a window wider than the dates and then filed by the shift each
 * trip happened in, the same way payroll reads them: a trip at 00:30 on the
 * 15th during a shift that started the night before is the 14th's, and only
 * the punches know that. Days that resolve outside the range are dropped.
 */
export async function loadReviewWindow(
  db: PrismaClient,
  args: { fromDate: string; toDate: string; driverId?: string },
): Promise<ReviewWindow> {
  const from = new Date(todayInBeirutDateRange(args.fromDate).startUtc.getTime() - PAIR_LOOKAROUND_MS);
  const to = new Date(todayInBeirutDateRange(args.toDate).endUtc.getTime() + PAIR_LOOKAROUND_MS);
  const trips = (await db.trip.findMany({
    where: { out_at: { gte: from, lt: to }, ...(args.driverId ? { driver_id: args.driverId } : {}) },
    orderBy: { out_at: 'asc' },
    select: REVIEW_TRIP_SELECT,
  })) as ReviewTrip[];
  const driverIds = [...new Set(trips.map((t) => t.driver_id))];
  const [users, punches] = await Promise.all([
    db.user.findMany({
      where: { id: { in: driverIds } },
      select: { id: true, username: true, name: true, branch_id: true, day_start_hour: true, branch: { select: { name: true } } },
    }),
    db.punch.findMany({
      where: {
        user_id: { in: driverIds },
        at: { gte: new Date(from.getTime() - PAIR_LOOKAROUND_MS), lt: new Date(to.getTime() + PAIR_LOOKAROUND_MS) },
      },
      orderBy: { at: 'asc' },
      select: { user_id: true, kind: true, at: true },
    }),
  ]);
  const punchesByDriver = new Map<string, PunchLite[]>();
  for (const p of punches) {
    const list = punchesByDriver.get(p.user_id) ?? [];
    list.push({ kind: p.kind, at: p.at });
    punchesByDriver.set(p.user_id, list);
  }
  const userById = new Map(users.map((u) => [u.id, u]));
  const grouped = tripsByDriverDay({
    trips,
    punchesByDriver,
    dayStartHourOf: (id) => dayStartHourFor(userById.get(id) ?? null),
  });
  const byDriver = new Map<string, Map<string, ReviewTrip[]>>();
  for (const [driverId, days] of grouped) {
    const kept = new Map<string, ReviewTrip[]>();
    for (const [date, list] of days) {
      if (date >= args.fromDate && date <= args.toDate) kept.set(date, list);
    }
    if (kept.size > 0) byDriver.set(driverId, kept);
  }
  const drivers = new Map<string, ReviewDriver>();
  for (const u of users) {
    drivers.set(u.id, { id: u.id, username: u.username, name: u.name, branch_id: u.branch_id, branch: u.branch });
  }
  return { byDriver, drivers };
}
