import type { PrismaClient, Punch } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { verifyWithinGeofence } from '@/lib/geofence';
import { writeAuditLog } from './audit';
import { getNotifier, type Notifier } from 'notify';

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
  | 'OPEN_TRIP_EXISTS'
  | 'OUT_OF_GEOFENCE'
  | 'LOW_GPS_ACCURACY'
  | 'ALREADY_PUNCHED_IN'
  | 'NOT_PUNCHED_IN'
  | 'USER_NOT_FOUND'
  | 'BRANCH_NOT_FOUND';

export interface PunchError {
  code: PunchErrorCode;
  // ALREADY_PUNCHED_IN only: the check-in still open from an earlier shift.
  // The caller needs it to tell the employee which shift is in the way -
  // "you are still checked in" with no time attached is not actionable.
  openInAt?: Date;
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
  const notify = input.notifier ?? getNotifier();

  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { branch: true },
  });
  if (!user) return { code: 'USER_NOT_FOUND' };
  if (!user.branch) return { code: 'BRANCH_NOT_FOUND' };
  if (!user.is_active) return { code: 'USER_NOT_FOUND' };

  // Note: an approved day-off does NOT block punching — staff sometimes come in
  // on a day off to help during a rush. Day-offs still affect attendance status
  // and suppress "absent" alerts, just not the ability to clock in.

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
    // Record the refusal. Note where we are: verifyWithinGeofence has already
    // passed, several statements above, so reaching this line proves the
    // employee is standing at their branch with acceptable GPS. An attempt
    // from home fails earlier as OUT_OF_GEOFENCE and is never recorded.
    //
    // That ordering is not incidental - it is what makes the paid credit these
    // rows drive impossible to game from a sofa. Anything that moves the
    // geofence check below this point, or records a blocked attempt from a
    // path that skips it, turns "I was at work and the system would not let me
    // clock in" into an unverified claim that pays.
    await recordBlockedAttempt(db, user, openIn!.at, input, now);
    return { code: 'ALREADY_PUNCHED_IN', openInAt: openIn!.at };
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

/**
 * File the evidence behind a refused check-in.
 *
 * Only ever called from the ALREADY_PUNCHED_IN branch above, and only from
 * there: the row's meaning is "this person was at the branch and the system
 * would not let them start", which is only true past the geofence check.
 * POST /api/me/punch/dev bypasses the geofence by design and so must never
 * write one.
 */
async function recordBlockedAttempt(
  db: PrismaClient,
  user: { id: string; branch: { id: string } | null },
  openInAt: Date,
  input: PunchInput,
  at: Date,
): Promise<void> {
  const attempt = await db.blockedPunchAttempt.create({
    data: {
      user_id: user.id,
      branch_id: user.branch!.id,
      at,
      open_in_at: openInAt,
      lat: input.lat,
      lng: input.lng,
      accuracy_m: Math.round(input.accuracy),
      device_fp: input.deviceFp,
      ip: input.ip,
    },
  });

  await writeAuditLog({
    actorId: user.id,
    action: 'punch.blocked',
    entity: 'BlockedPunchAttempt',
    entityId: attempt.id,
    after: {
      at: attempt.at.toISOString(),
      open_in_at: attempt.open_in_at.toISOString(),
      lat: attempt.lat,
      lng: attempt.lng,
      accuracy_m: attempt.accuracy_m,
      branch_id: attempt.branch_id,
      reason: 'Check-in refused: an earlier check-in is still open. Recorded past the geofence check.',
    },
    db,
  });
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
  notifierInstance?: Notifier,
): Promise<void> {
  const candidate = await db.flag.findFirst({
    where: { kind: 'WATCHED', user_id: user.id, resolved_at: null },
    orderBy: { created_at: 'asc' },
  });
  if (!candidate) return;
  const claim = await db.flag.updateMany({
    where: { id: candidate.id, resolved_at: null },
    data: { resolved_at: new Date() },
  });
  if (claim.count !== 1) return;
  await (notifierInstance ?? getNotifier()).send({
    channel: 'telegram',
    recipient: 'admin',
    template: 'watched_resolved',
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
