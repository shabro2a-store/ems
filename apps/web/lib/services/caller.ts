import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { todayInBeirut, todayInBeirutDateRange } from 'time';
import { sendPushToUser } from './push';

export interface DriverStatus {
  id: string;
  username: string;
  name: string;
  clocked_in: boolean;
  available: boolean; // clocked in and not currently on a trip
  open_trip_since: string | null; // ISO out_at while on a trip, else null
  trips_today: number; // trips since this shift's clock-in (resets at clock-out)
  ringing: boolean; // an unacknowledged ring in the last 2 minutes
}

const RING_WINDOW_MS = 2 * 60 * 1000;

// Live status of every driver in a branch — for the caller board and the admin dashboard.
export async function branchDriverStatuses(
  branchId: string,
  db: PrismaClient = defaultPrisma,
): Promise<DriverStatus[]> {
  const drivers = await db.user.findMany({
    where: { role: 'DRIVER', branch_id: branchId, is_active: true },
    select: { id: true, username: true, name: true },
    orderBy: { username: 'asc' },
  });

  const ringCutoff = new Date(Date.now() - RING_WINDOW_MS);

  return Promise.all(
    drivers.map(async (d) => {
      const lastIn = await db.punch.findFirst({
        where: { user_id: d.id, kind: 'IN' },
        orderBy: { at: 'desc' },
        select: { at: true },
      });
      let clockedIn = false;
      let clockInAt: Date | null = null;
      if (lastIn) {
        const laterOut = await db.punch.findFirst({
          where: { user_id: d.id, kind: 'OUT', at: { gt: lastIn.at } },
          select: { id: true },
        });
        if (!laterOut) {
          clockedIn = true;
          clockInAt = lastIn.at;
        }
      }

      const openTrip = await db.trip.findFirst({
        where: { driver_id: d.id, back_at: null },
        select: { out_at: true },
      });

      const tripsToday = clockInAt
        ? await db.trip.count({ where: { driver_id: d.id, out_at: { gte: clockInAt } } })
        : 0;

      const pendingRing = await db.driverCall.findFirst({
        where: { driver_id: d.id, acknowledged_at: null, created_at: { gte: ringCutoff } },
        select: { id: true },
      });

      return {
        id: d.id,
        username: d.username,
        name: d.name || d.username,
        clocked_in: clockedIn,
        available: clockedIn && !openTrip,
        open_trip_since: openTrip ? openTrip.out_at.toISOString() : null,
        trips_today: tripsToday,
        ringing: Boolean(pendingRing),
      };
    }),
  );
}

export type RingResult = { ok: true; id: string } | { ok: false; code: 'NOT_FOUND' | 'WRONG_BRANCH' | 'NOT_CLOCKED_IN' };

// Record a ring (the driver's app polls for it and raises the alarm).
export async function ringDriver(
  args: { callerId: string; driverId: string; branchId: string; db?: PrismaClient },
): Promise<RingResult> {
  const db = args.db ?? defaultPrisma;
  const driver = await db.user.findUnique({
    where: { id: args.driverId },
    select: { role: true, branch_id: true, is_active: true },
  });
  if (!driver || driver.role !== 'DRIVER' || !driver.is_active) return { ok: false, code: 'NOT_FOUND' };
  if (driver.branch_id !== args.branchId) return { ok: false, code: 'WRONG_BRANCH' };

  const call = await db.driverCall.create({
    data: { driver_id: args.driverId, caller_id: args.callerId, branch_id: args.branchId },
    select: { id: true },
  });
  // Also fire a web-push so a locked/closed phone rings (best-effort; the in-app
  // alarm covers the app-open case regardless).
  await sendPushToUser(
    args.driverId,
    { title: '📞 Order ready!', body: 'The counter is calling you to collect an order.', url: '/driver' },
    db,
  ).catch(() => {});
  return { ok: true, id: call.id };
}

// Count of trips a driver made within today's Beirut day (permanent daily total,
// independent of shift resets) — for the admin dashboard.
export async function driverTripsToday(
  driverId: string,
  db: PrismaClient = defaultPrisma,
): Promise<number> {
  const { startUtc, endUtc } = todayInBeirutDateRange(todayInBeirut());
  return db.trip.count({ where: { driver_id: driverId, out_at: { gte: startUtc, lt: endUtc } } });
}
