import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';

/**
 * Past this, an open trip is a forgotten BACK press rather than a delivery.
 *
 * The worker's copy of MAX_OPEN_TRIP_MIN in apps/web/lib/services/tripClose.ts,
 * which is the definition of record and which the driver's punch path uses too.
 * The worker is a separate pnpm package and cannot import from apps/web;
 * autoCloseAbandonedTrips.test.ts pins the two together the same way
 * autoCloseAbandoned.test.ts pins the punch pair.
 *
 * It sits above driverStale's 4h alert on purpose - the owner is always told
 * about a trip before anything closes it.
 */
export const MAX_OPEN_TRIP_MIN = 6 * 60;

/**
 * When a trip nobody closed is deemed to have ended: out + the minutes that
 * branch says a delivery takes.
 *
 * The worker's copy of systemBackAt in apps/web/lib/services/tripClose.ts. See
 * the original for the one-minute floor.
 */
export function systemBackAt(outAt: Date, thresholdMin: number): Date {
  return new Date(outAt.getTime() + Math.max(thresholdMin, 1) * 60_000);
}

export interface AutoCloseAbandonedTripsOpts {
  db?: PrismaClient;
  now?: Date;
}

export interface AutoCloseAbandonedTripsResult {
  closed: number;
}

/**
 * End the trips nobody pressed BACK on.
 *
 * A driver's punch path closes an abandoned trip the moment they try to clock,
 * which is what ends the lockout. This job is for the trips nobody comes back
 * to: a driver on leave, one who quit, one whose phone died on the road. Left
 * open they hold two things hostage - the unique partial index trip_one_open
 * means the driver can never start another order, and caller.ts reports them
 * as out on a delivery forever, so the counter never rings them again.
 *
 * The written return is out + the branch's own trip_threshold_min: a BACK
 * nobody pressed cannot say when the driver got back, so the system credits
 * the delivery the branch defines and nothing more. Same ruling as the punch
 * side, where an abandoned check-in closes at the hours the day owed.
 */
export async function runAutoCloseAbandonedTrips(
  opts: AutoCloseAbandonedTripsOpts = {},
): Promise<AutoCloseAbandonedTripsResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - MAX_OPEN_TRIP_MIN * 60_000);

  const openTrips = await db.trip.findMany({
    where: { back_at: null, out_at: { lt: cutoff } },
    select: {
      id: true,
      driver_id: true,
      out_at: true,
      branch: { select: { lat: true, lng: true, trip_threshold_min: true } },
    },
  });

  let closed = 0;

  for (const t of openTrips) {
    const thresholdMin = t.branch?.trip_threshold_min ?? 30;
    const closeAt = systemBackAt(t.out_at, thresholdMin);
    const openMin = Math.floor((now.getTime() - t.out_at.getTime()) / 60_000);

    const wrote = await db.$transaction(async (tx) => {
      // Conditional on back_at still being null, so a real BACK landing between
      // the scan and the write always wins and two overlapping runs of this job
      // cannot both close the same trip.
      const claim = await tx.trip.updateMany({
        where: { id: t.id, back_at: null },
        data: {
          back_at: closeAt,
          // The branch's own coordinates, not the driver's: nobody stood
          // anywhere to make this. system_generated is what says so.
          back_lat: t.branch?.lat ?? 0,
          back_lng: t.branch?.lng ?? 0,
          system_generated: true,
        },
      });
      if (claim.count !== 1) return false;

      await tx.auditLog.create({
        data: {
          // Not a user id: no person did this. AuditLog.actor_id has no foreign
          // key, so the literal reads honestly in the log.
          actor_id: 'system',
          action: 'trip.auto_close',
          entity: 'Trip',
          entity_id: t.id,
          after_json: {
            driver_id: t.driver_id,
            out_at: t.out_at.toISOString(),
            back_at: closeAt.toISOString(),
            system_generated: true,
            trigger: 'abandoned_sweep',
            open_min: openMin,
            threshold_min: thresholdMin,
            abandoned_after_min: MAX_OPEN_TRIP_MIN,
            reason:
              `Trip open ${openMin} min with no BACK press, past the ${MAX_OPEN_TRIP_MIN} min abandoned ` +
              `threshold. Closed at out plus the ${thresholdMin} min this branch allows for a delivery, ` +
              `so the driver is free to be dispatched and to clock again.`,
          },
        },
      });

      return true;
    });

    if (wrote) closed += 1;
  }

  return { closed };
}
