import type { PrismaClient, Punch } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { verifyWithinGeofence } from '@/lib/geofence';
import { MAX_OPEN_SESSION_MIN } from './coverage';
import { writeAuditLog } from './audit';
import {
  abandonedSessionClose,
  requiredMinForArrival,
  staleSessionClose,
  writeSystemCheckout,
} from './autoClose';
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
  // A session left open from a shift-day that is over was closed by the system
  // as part of serving this request, at that day's scheduled hours. The caller
  // has to say so: on a check-in it explains a shift the employee thought was
  // still running, and on a clock-out it explains why `punch` is not the punch
  // they just made.
  systemClosedAt?: Date;
  // True only on a clock-out that resolved into a system close: `punch` is the
  // system's checkout, not the employee's.
  systemClosedInsteadOfPunch?: boolean;
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
    // branch_id so a system checkout is attributed to the branch the shift was
    // actually worked at, which is not always the employee's current branch.
    select: { id: true, at: true, branch_id: true },
  });
  const laterOpenOut = openIn
    ? await db.punch.findFirst({
        where: { user_id: user.id, kind: 'OUT', at: { gt: openIn.at } },
        select: { id: true },
      })
    : null;

  const hasOpenSession = Boolean(openIn) && !laterOpenOut;

  // A session left open from a shift-day that is over is the system's to close,
  // not the employee's. Somebody standing at the branch, past the geofence,
  // asking to start a shift has demonstrably finished the old one - which is
  // better evidence than the 30h sweep ever has, so the same close the sweep
  // would eventually write happens here instead, at the same instant
  // (systemCheckoutAt) with the same system_generated marking and audit.
  //
  // This is what stops the block being a wall. Before it, the employee's screen
  // offered CLOCK OUT on the stale session, they tapped it, and payroll paid
  // the entire runaway span; and a night worker refused at 21:00 with no
  // check-in that Beirut day lost the night with nothing on any queue.
  //
  // The threshold is ASYMMETRIC, and that is the whole of it. On a check-in the
  // new punch is itself the evidence the old shift ended, and nothing the
  // employee made is discarded - so `required + grace` on an earlier Beirut day
  // is enough. On a clock-out the employee is standing there asserting the
  // truth about their own shift, and the system must not overrule them: only a
  // session past MAX_OPEN_SESSION_MIN, which is no longer a shift by the
  // codebase's own definition, may be closed out from under a punch they made.
  //
  // Using the check-in threshold on the clock-out path silently truncated real
  // work: a night worker on a 10h shift clocking out at 07:16 was paid 600
  // minutes for 616, and the record said 07:00. Between `required + grace` and
  // 30h the overrun is plausibly real, and the overtime notice is the control
  // the owner already has for it.
  let systemClosed: Punch | null = null;
  let resolvedStaleSession = false;
  if (hasOpenSession) {
    const requiredMin = await requiredMinForArrival(db, user.id, openIn!.at);
    const stale =
      input.kind === 'IN'
        ? staleSessionClose({
            arrivalAt: openIn!.at,
            now,
            requiredMin,
            graceMin: user.branch.shift_grace_min,
          })
        : abandonedSessionClose({ arrivalAt: openIn!.at, now, requiredMin });
    if (stale) {
      resolvedStaleSession = true;
      systemClosed = await writeSystemCheckout(db, {
        userId: user.id,
        branchId: openIn!.branch_id,
        branchLat: user.branch.lat,
        branchLng: user.branch.lng,
        arrivalAt: openIn!.at,
        arrivalPunchId: openIn!.id,
        closeAt: stale.closeAt,
        requiredMin: stale.requiredMin,
        now,
        trigger: input.kind === 'IN' ? 'new_check_in' : 'stale_clock_out',
        reason:
          input.kind === 'IN'
            ? `${user.username} started a new shift while the session opened ${openIn!.at.toISOString()} ` +
              `was still open. That session belongs to a shift-day that is over and had run past its ` +
              `${stale.requiredMin} min plus the branch grace, and a geofence-passing check-in now is ` +
              `evidence it ended. Closed at check-in plus those ${stale.requiredMin} min. Overtime ` +
              `actually worked that night is not included and must be added as a bonus.`
            : `${user.username} tried to clock out of the session opened ${openIn!.at.toISOString()}, ` +
              `which had been open past the ${MAX_OPEN_SESSION_MIN} min abandoned threshold and is no ` +
              `longer a shift. Closed at check-in plus the ${stale.requiredMin} min that day required ` +
              `rather than paying the whole span. No punch of theirs was written.`,
      });
    }
  }

  if (input.kind === 'IN' && hasOpenSession && !resolvedStaleSession) {
    // Record the refusal. Note where we are: verifyWithinGeofence has already
    // passed, above, so reaching this line proves the employee is standing at
    // their branch with acceptable GPS. An attempt from home fails earlier as
    // OUT_OF_GEOFENCE and is never recorded.
    //
    // That ordering is not incidental - it is what makes the paid credit these
    // rows drive impossible to game from a sofa. Anything that moves the
    // geofence check below this point, or records a blocked attempt from a
    // path that skips it, turns "I was at work and the system would not let me
    // clock in" into an unverified claim that pays.
    //
    // A self-resolved stale session records nothing: nothing was refused, and
    // the check-in punch that follows is stronger evidence than a row saying it
    // was turned away would be.
    await recordBlockedAttempt(db, user, openIn!.at, input, now);
    return { code: 'ALREADY_PUNCHED_IN', openInAt: openIn!.at };
  }
  if (input.kind === 'OUT' && !hasOpenSession) {
    return { code: 'NOT_PUNCHED_IN' };
  }
  if (input.kind === 'OUT' && resolvedStaleSession) {
    // They asked to clock out of a shift that ended on an earlier day. Writing
    // their checkout at `now` is exactly the runaway payment this whole change
    // exists to stop, and backdating their own punch would make the record lie
    // about when they pressed the button. So the system's checkout stands and
    // no punch of theirs is written; the response says so.
    const closed = systemClosed ?? (await db.punch.findFirst({
      where: { user_id: user.id, kind: 'OUT', at: { gt: openIn!.at } },
      orderBy: { at: 'asc' },
    }));
    if (closed) {
      return {
        punch: closed,
        minutes_since_in: Math.max(0, Math.floor((closed.at.getTime() - openIn!.at.getTime()) / 60_000)),
        systemClosedAt: closed.at,
        systemClosedInsteadOfPunch: true,
      };
    }
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

  return {
    punch,
    minutes_since_in,
    ...(systemClosed ? { systemClosedAt: systemClosed.at } : {}),
  };
}

/**
 * File the evidence behind a refused check-in.
 *
 * Only ever called from the ALREADY_PUNCHED_IN branch in punchEmployee, and
 * only from there: the row's meaning is "this person was at the branch and the
 * system would not let them start", which is only true past the geofence check.
 * POST /api/me/punch/dev bypasses the geofence by design and so must never
 * write one.
 *
 * Failures are swallowed. This is bookkeeping on a request that is already
 * being refused, and letting a write error propagate would turn a 409 the
 * employee can act on into a 500 they cannot - trading the whole message for a
 * row nobody is waiting on. The lost row costs at most some credit the owner
 * would have had to approve anyway.
 */
async function recordBlockedAttempt(
  db: PrismaClient,
  user: { id: string; branch: { id: string } | null },
  openInAt: Date,
  input: PunchInput,
  at: Date,
): Promise<void> {
  try {
    await writeBlockedAttempt(db, user, openInAt, input, at);
  } catch (e) {
    console.error('[punch] could not record blocked attempt', e);
  }
}

async function writeBlockedAttempt(
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
