import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { verifyWithinGeofence } from '@/lib/geofence';
import { abandonedTripClose } from './tripClose';

export type TripErrorCode =
  | 'USER_NOT_FOUND'
  | 'BRANCH_NOT_FOUND'
  | 'NOT_DRIVER'
  | 'NOT_DISPATCHED'
  | 'OPEN_TRIP_EXISTS'
  | 'NO_OPEN_TRIP'
  | 'OUT_OF_GEOFENCE'
  | 'LOW_GPS_ACCURACY';

// A driver may only go out on an order after the caller has rung them. The ring
// (DriverCall) is valid for this long and can dispatch exactly one trip.
export const DISPATCH_WINDOW_MS = 30 * 60 * 1000;

export interface TripInput {
  userId: string;
  lat: number;
  lng: number;
  accuracy: number;
  now?: Date;
}

export type StartTripResult =
  | { ok: true; trip_id: string; out_at: Date }
  | { ok: false; code: TripErrorCode };

export async function startTrip(
  input: TripInput,
  db: PrismaClient = defaultPrisma,
): Promise<StartTripResult> {
  const now = input.now ?? new Date();
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { branch: true },
  });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
  if (user.role !== 'DRIVER') return { ok: false, code: 'NOT_DRIVER' };
  if (!user.branch) return { ok: false, code: 'BRANCH_NOT_FOUND' };
  if (!user.is_active) return { ok: false, code: 'USER_NOT_FOUND' };

  // An approved day-off does not block trips — a driver may come in to help.

  const open = await db.trip.findFirst({
    where: { driver_id: user.id, back_at: null },
    select: { id: true },
  });
  if (open) return { ok: false, code: 'OPEN_TRIP_EXISTS' };

  // Must have been dispatched (rung) by the caller, and that ring must not have
  // already been used for another trip.
  const call = await db.driverCall.findFirst({
    where: {
      driver_id: user.id,
      trip_id: null,
      created_at: { gte: new Date(now.getTime() - DISPATCH_WINDOW_MS) },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  });
  if (!call) return { ok: false, code: 'NOT_DISPATCHED' };

  const geo = verifyWithinGeofence(
    input.lat,
    input.lng,
    [
      {
        id: user.branch.id,
        lat: user.branch.lat,
        lng: user.branch.lng,
        gps_radius_m: user.branch.gps_radius_m,
        gps_accuracy_max_m: user.branch.gps_accuracy_max_m,
        is_active: user.branch.is_active,
      },
    ],
    input.accuracy,
  );
  if (!geo.ok) {
    if (geo.reason === 'LOW_GPS_ACCURACY') return { ok: false, code: 'LOW_GPS_ACCURACY' };
    return { ok: false, code: 'OUT_OF_GEOFENCE' };
  }

  const trip = await db.$transaction(async (tx) => {
    const t = await tx.trip.create({
      data: {
        driver_id: user.id,
        branch_id: user.branch!.id,
        out_at: now,
        out_lat: input.lat,
        out_lng: input.lng,
      },
    });
    // Consume the dispatch call — guard on trip_id null so a concurrent start
    // can't reuse the same ring.
    await tx.driverCall.updateMany({
      where: { id: call.id, trip_id: null },
      data: { trip_id: t.id },
    });
    return t;
  });

  return { ok: true, trip_id: trip.id, out_at: trip.out_at };
}

export interface EndTripInput {
  userId: string;
  lat: number;
  lng: number;
  accuracy: number;
  now?: Date;
}

export type EndTripResult =
  | { ok: true; trip_id: string; back_at: Date; duration_min: number }
  | { ok: false; code: TripErrorCode };

export async function endTrip(
  input: EndTripInput,
  db: PrismaClient = defaultPrisma,
): Promise<EndTripResult> {
  const now = input.now ?? new Date();
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { branch: true },
  });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
  if (user.role !== 'DRIVER') return { ok: false, code: 'NOT_DRIVER' };
  if (!user.branch) return { ok: false, code: 'BRANCH_NOT_FOUND' };

  const open = await db.trip.findFirst({
    where: { driver_id: user.id, back_at: null },
    orderBy: { out_at: 'desc' },
  });
  if (!open) return { ok: false, code: 'NO_OPEN_TRIP' };

  const geo = verifyWithinGeofence(
    input.lat,
    input.lng,
    [
      {
        id: user.branch.id,
        lat: user.branch.lat,
        lng: user.branch.lng,
        gps_radius_m: user.branch.gps_radius_m,
        gps_accuracy_max_m: user.branch.gps_accuracy_max_m,
        is_active: user.branch.is_active,
      },
    ],
    input.accuracy,
  );
  if (!geo.ok) {
    if (geo.reason === 'LOW_GPS_ACCURACY') return { ok: false, code: 'LOW_GPS_ACCURACY' };
    return { ok: false, code: 'OUT_OF_GEOFENCE' };
  }

  const updated = await db.trip.update({
    where: { id: open.id },
    data: {
      back_at: now,
      back_lat: input.lat,
      back_lng: input.lng,
    },
  });

  const durationMs = now.getTime() - updated.out_at.getTime();
  const duration_min = Math.max(0, Math.floor(durationMs / 60_000));

  return { ok: true, trip_id: updated.id, back_at: updated.back_at!, duration_min };
}

export interface CurrentTripInfo {
  open: boolean;
  since_min?: number;
  threshold_min: number;
  /**
   * The open trip is past MAX_OPEN_TRIP_MIN and no longer blocks a punch - the
   * next clock press closes it. Computed server-side with the same predicate
   * punchEmployee uses, for the same reason open_session_stale is: the driver's
   * screen decides whether to offer the clock button from this, and a screen
   * that disagrees with the server about what is blocked is how the lockout
   * looked to the driver in the first place.
   */
  stale: boolean;
}

export async function currentTrip(
  userId: string,
  db: PrismaClient = defaultPrisma,
): Promise<CurrentTripInfo> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { branch: true },
  });
  const threshold_min = user?.branch?.trip_threshold_min ?? 30;

  const open = await db.trip.findFirst({
    where: { driver_id: userId, back_at: null },
    orderBy: { out_at: 'desc' },
  });
  if (!open) return { open: false, threshold_min, stale: false };
  const now = new Date();
  const since_min = Math.max(0, Math.floor((now.getTime() - open.out_at.getTime()) / 60_000));
  const stale =
    abandonedTripClose({ outAt: open.out_at, now, thresholdMin: threshold_min }) !== null;
  return { open: true, since_min, threshold_min, stale };
}