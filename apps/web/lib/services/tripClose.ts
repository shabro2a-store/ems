import type { PrismaClient, Trip } from '@prisma/client';

/**
 * Past this, an open trip is a forgotten BACK press rather than a delivery.
 *
 * An open Trip is a hard gate on every driver punch (see punchEmployee), and
 * for a long time it was the only gate in the system with no expiry and no
 * closer but the driver's own geofenced BACK press: `driverStale` and
 * `tripThreshold` send Telegram alerts and write no `back_at`, the abandoned
 * sweep closes punches and not trips, and no admin route touches a Trip at
 * all. A driver who forgot to press BACK could therefore neither clock in nor
 * clock out, and their only way through was to press BACK the next morning -
 * writing a return time they did not make - after being told to "press Back,
 * then clock out" while they were trying to clock in.
 *
 * The trip nobody ever comes back to had no way through at all. A driver who
 * quits, goes on leave or loses the phone leaves it open forever: the unique
 * partial index trip_one_open means they can never be given another order,
 * caller.ts reports them out on a delivery for good so the counter stops
 * ringing them, the owner's dashboard shows a driver permanently out, and
 * driverStale - which has no dedupe - re-alerts every thirty minutes until
 * somebody edits the database.
 *
 * The number sits deliberately between two that already exist:
 *
 *  - ABOVE `driverStale`'s 4h "phone dead or stranded" alert, so the owner has
 *    always been told about a trip before anything closes it. Notify first,
 *    close later - the same order as missedCheckout before autoCloseAbandoned.
 *  - BELOW the gap between one shift and the next, so a BACK forgotten at the
 *    end of an evening can never block the following morning.
 *
 * It is not the punch threshold. MAX_OPEN_SESSION_MIN is 30h because a shift
 * can legitimately run 24h; a delivery cannot, and `trip_threshold_min` caps
 * at 240 minutes for exactly that reason.
 */
export const MAX_OPEN_TRIP_MIN = 6 * 60;

/**
 * When a trip nobody closed is deemed to have ended: out + the minutes that
 * branch says a delivery takes.
 *
 * `trip_threshold_min` is the owner's own number, already tunable per branch
 * from the admin UI and already the basis of the over-threshold alert. A BACK
 * nobody pressed cannot say when the driver got back, so the system credits
 * the delivery the branch defines and nothing more - the same ruling as the
 * punch side, where an abandoned check-in is closed at the hours the day owed.
 *
 * The one-minute floor mirrors systemCheckoutAt. It is unreachable today
 * (`tripThresholdMin` is validated at min(1)), and it stays because the cost of
 * being wrong is not a rounding error: a `back_at` equal to `out_at` would
 * still clear `back_at IS NULL`, but it would render as a zero-minute delivery
 * in every feed that shows one.
 */
export function systemBackAt(outAt: Date, thresholdMin: number): Date {
  return new Date(outAt.getTime() + Math.max(thresholdMin, 1) * 60_000);
}

export interface AbandonedTripCheck {
  /** The `back_at` that would be written. */
  closeAt: Date;
  thresholdMin: number;
}

/**
 * Whether an open trip has stopped being a delivery at all.
 *
 * Deliberately independent of where the driver is standing. The punch path and
 * the worker sweep both call this and must agree; the sweep has no location to
 * check, and a trip six hours old is over whether the driver is at the branch,
 * at home, or has left the country.
 */
export function abandonedTripClose(args: {
  outAt: Date;
  now: Date;
  thresholdMin: number;
}): AbandonedTripCheck | null {
  const elapsedMin = Math.floor((args.now.getTime() - args.outAt.getTime()) / 60_000);
  if (elapsedMin <= MAX_OPEN_TRIP_MIN) return null;
  return { closeAt: systemBackAt(args.outAt, args.thresholdMin), thresholdMin: args.thresholdMin };
}

/**
 * Write the BACK an abandoned trip never got, with the record of why.
 *
 * The write is a conditional updateMany on `back_at: null`, so a real BACK
 * landing between the read and the write always wins and two writers cannot
 * both close the same trip. Returns null when it lost that race.
 */
export async function writeSystemTripClose(
  db: PrismaClient,
  args: {
    tripId: string;
    driverId: string;
    outAt: Date;
    branchLat: number;
    branchLng: number;
    closeAt: Date;
    thresholdMin: number;
    now: Date;
    trigger: 'abandoned_sweep' | 'driver_punch';
    reason: string;
  },
): Promise<Trip | null> {
  return db.$transaction(async (tx) => {
    const claim = await tx.trip.updateMany({
      where: { id: args.tripId, back_at: null },
      data: {
        back_at: args.closeAt,
        // The branch's own coordinates, not the driver's: nobody stood
        // anywhere to make this. system_generated is what says so.
        back_lat: args.branchLat,
        back_lng: args.branchLng,
        system_generated: true,
      },
    });
    if (claim.count !== 1) return null;

    const openMin = Math.floor((args.now.getTime() - args.outAt.getTime()) / 60_000);

    await tx.auditLog.create({
      data: {
        // Not a user id: no person did this. AuditLog.actor_id has no foreign
        // key, so the literal reads honestly in the log.
        actor_id: 'system',
        action: 'trip.auto_close',
        entity: 'Trip',
        entity_id: args.tripId,
        after_json: {
          driver_id: args.driverId,
          out_at: args.outAt.toISOString(),
          back_at: args.closeAt.toISOString(),
          system_generated: true,
          trigger: args.trigger,
          open_min: openMin,
          threshold_min: args.thresholdMin,
          abandoned_after_min: MAX_OPEN_TRIP_MIN,
          reason: args.reason,
        },
      },
    });

    return tx.trip.findUnique({ where: { id: args.tripId } });
  });
}
