import type { PrismaClient, Punch } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { verifyWithinGeofence } from '@/lib/geofence';
import { userHasApprovedDayOffToday } from './dayOff';
import { writeAuditLog } from './audit';
import { notifier, type Notifier } from 'notify';

export type PunchDirection = 'IN' | 'OUT';

export interface PunchInput {
  userId: string;
  kind: PunchDirection;
  lat: number;
  lng: number;
  accuracy: number;
  deviceFp: string;
  ip: string;
  now?: Date;
  notifier?: Notifier;
}

export type PunchErrorCode =
  | 'DAY_OFF_PUNCH_BLOCKED'
  | 'OPEN_TRIP_EXISTS'
  | 'OUT_OF_GEOFENCE'
  | 'LOW_GPS_ACCURACY'
  | 'ALREADY_PUNCHED_IN'
  | 'NOT_PUNCHED_IN'
  | 'USER_NOT_FOUND'
  | 'BRANCH_NOT_FOUND';

export interface PunchError {
  code: PunchErrorCode;
}

export interface PunchOk {
  punch: Punch;
  minutes_since_in: number | null;
}

export type PunchResult = PunchOk | PunchError;

export async function punchEmployee(
  input: PunchInput,
  db: PrismaClient = defaultPrisma,
): Promise<PunchResult> {
  const now = input.now ?? new Date();
  const notify = input.notifier ?? notifier;

  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { branch: true },
  });
  if (!user) return { code: 'USER_NOT_FOUND' };
  if (!user.branch) return { code: 'BRANCH_NOT_FOUND' };
  if (!user.is_active) return { code: 'USER_NOT_FOUND' };

  if (await userHasApprovedDayOffToday(user.id, now)) {
    return { code: 'DAY_OFF_PUNCH_BLOCKED' };
  }

  if (user.role === 'DRIVER') {
    const openTrip = await db.trip.findFirst({
      where: { driver_id: user.id, back_at: null },
      select: { id: true },
    });
    if (openTrip) return { code: 'OPEN_TRIP_EXISTS' };
  }

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
    if (geo.reason === 'LOW_GPS_ACCURACY') return { code: 'LOW_GPS_ACCURACY' };
    return { code: 'OUT_OF_GEOFENCE' };
  }

  const openIn = await db.punch.findFirst({
    where: { user_id: user.id, kind: 'IN' },
    orderBy: { at: 'desc' },
    select: { id: true, at: true },
  });
  const laterOpenOut = openIn
    ? await db.punch.findFirst({
        where: { user_id: user.id, kind: 'OUT', at: { gt: openIn.at } },
        select: { id: true },
      })
    : null;

  const hasOpenSession = Boolean(openIn) && !laterOpenOut;

  if (input.kind === 'IN' && hasOpenSession) {
    return { code: 'ALREADY_PUNCHED_IN' };
  }
  if (input.kind === 'OUT' && !hasOpenSession) {
    return { code: 'NOT_PUNCHED_IN' };
  }

  const punch = await db.punch.create({
    data: {
      user_id: user.id,
      branch_id: user.branch.id,
      kind: input.kind,
      at: now,
      lat: input.lat,
      lng: input.lng,
      accuracy_m: Math.round(input.accuracy),
      device_fp: input.deviceFp,
      ip: input.ip,
    },
  });

  await resolveWatchedFlag(db, user, punch, notify);

  await writeAuditLog({
    actorId: user.id,
    action: 'punch.create',
    entity: 'Punch',
    entityId: punch.id,
    after: {
      kind: punch.kind,
      at: punch.at.toISOString(),
      lat: punch.lat,
      lng: punch.lng,
      accuracy_m: punch.accuracy_m,
      branch_id: punch.branch_id,
    },
    db,
  });

  let minutes_since_in: number | null = null;
  if (input.kind === 'IN') {
    minutes_since_in = 0;
  } else {
    const sinceMs = now.getTime() - (openIn!.at.getTime());
    minutes_since_in = Math.max(0, Math.floor(sinceMs / 60_000));
  }

  return { punch, minutes_since_in };
}

interface UserWithBranch {
  id: string;
  username: string;
  branch_id: string | null;
  branch: { id: string; name: string } | null;
}

export async function resolveWatchedFlag(
  db: PrismaClient,
  user: UserWithBranch,
  punch: Punch,
  notifierInstance: Notifier = notifier,
): Promise<void> {
  const candidate = await db.flag.findFirst({
    where: { kind: 'WATCHED', user_id: user.id, notified_at: null },
    orderBy: { created_at: 'asc' },
  });
  if (!candidate) return;
  const claim = await db.flag.updateMany({
    where: { id: candidate.id, notified_at: null },
    data: { notified_at: new Date() },
  });
  if (claim.count !== 1) return;
  await notifierInstance.send({
    channel: 'telegram',
    recipient: 'admin',
    template: 'watched.resolved',
    context: { user: { id: user.id, username: user.username }, punch, watched: candidate },
  });
}

export async function currentOpenIn(
  userId: string,
  db: PrismaClient = defaultPrisma,
): Promise<{ in_at: Date; minutes_since_in: number } | null> {
  const lastIn = await db.punch.findFirst({
    where: { user_id: userId, kind: 'IN' },
    orderBy: { at: 'desc' },
  });
  if (!lastIn) return null;
  const laterOut = await db.punch.findFirst({
    where: { user_id: userId, kind: 'OUT', at: { gt: lastIn.at } },
  });
  if (laterOut) return null;
  const sinceMs = Date.now() - lastIn.at.getTime();
  const minutes_since_in = Math.max(0, Math.floor(sinceMs / 60_000));
  return { in_at: lastIn.at, minutes_since_in };
}
