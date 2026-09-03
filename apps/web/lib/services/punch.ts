import type { PrismaClient, Punch, Trip } from '@prisma/client';
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
import { abandonedTripClose, writeSystemTripClose, MAX_OPEN_TRIP_MIN } from './tripClose';
import { punchableBranches } from './branchScope';
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
  // A trip left open past MAX_OPEN_TRIP_MIN was closed by the system as part
  // of serving this request, at the dispatching branch's delivery time. The
  // driver's screen shows "Out on an order" until it refreshes, so it has to
  // be told the order was ended for them and when.
  systemClosedTripAt?: Date;
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

  // A driver out on a delivery is not at the branch to clock, so an open trip
  // blocks the punch. The trouble was that a trip had no end but a BACK press
  // the driver had to remember, and nothing else in the system could write one
  // - so a press that never came was an attendance lockout, escapable only by
  // pressing BACK the next morning and recording a return that did not happen.
  // A driver who never came back at all - quit, on leave, phone gone - left it
  // open for good; see tripClose.ts for what that cost.
  //
  // Past MAX_OPEN_TRIP_MIN the trip is not a delivery, so it is closed here at
  // the dispatching branch's own delivery time and the punch goes through. A
  // live delivery is still refused, and this stays ABOVE the geofence check:
  // whether a six-hour-old trip is over does not depend on where the driver is
  // standing, and keeping the refusal here is what keeps a driver stopped by
  // it out of recordBlockedAttempt, whose rows are paid.
  let systemClosedTrip: Trip | null = null;
  if (user.role === 'DRIVER') {
    const openTrip = await db.trip.findFirst({
      where: { driver_id: user.id, back_at: null },
      select: {
        id: true,
        out_at: true,
        // The threshold of the branch the order was dispatched from, not of
        // whatever branch the driver belongs to today.
        branch: { select: { lat: true, lng: true, trip_threshold_min: true } },
      },
    });
    if (openTrip) {
      const abandoned = abandonedTripClose({
        outAt: openTrip.out_at,
        now,
        thresholdMin: openTrip.branch.trip_threshold_min,
      });
      if (!abandoned) return { code: 'OPEN_TRIP_EXISTS' };
      systemClosedTrip = await writeSystemTripClose(db, {
        tripId: openTrip.id,
        driverId: user.id,
        outAt: openTrip.out_at,
        branchLat: openTrip.branch.lat,
        branchLng: openTrip.branch.lng,
        closeAt: abandoned.closeAt,
        thresholdMin: abandoned.thresholdMin,
        now,
        trigger: 'driver_punch',
        reason:
          `${user.username} punched ${input.kind} with the trip opened ${openTrip.out_at.toISOString()} ` +
          `still out. It had been open past the ${MAX_OPEN_TRIP_MIN} min abandoned threshold and is no ` +
          `longer a delivery, so it was closed at out plus the ${abandoned.thresholdMin} min this ` +
          `branch allows for one rather than blocking the punch. No BACK of theirs was recorded.`,
      });
    }
  }

  // One branch normally, every active branch for somebody the owner has let
  // roam. verifyWithinGeofence already picks the nearest and drops inactive
  // branches, so the two cases are the same code with a longer list.
  const geo = verifyWithinGeofence(
    input.lat,
    input.lng,
    // `user.branch` is proved non-null above; spreading the record does not
    // carry that narrowing, so the field is passed explicitly.
    await punchableBranches(
      db,
      { id: user.id, can_roam_branches: user.can_roam_branches, branch: user.branch },
      input.kind,
    ),
    input.accuracy,
  );
  if (!geo.ok) {
    if (geo.reason === 'LOW_GPS_ACCURACY') return { code: 'LOW_GPS_ACCURACY' };
    return { code: 'OUT_OF_GEOFENCE' };
  }

  // The branch they are actually standing at, which for a roaming employee is
  // not their own. Every row this request writes is attributed here rather than
  // to user.branch_id: a punch says where the hours were worked, and "who is at
  // Hamra right now" is only true if the punches say so. Identical to
  // user.branch.id for everybody else, since that is the only candidate.
  const atBranch = geo.nearest;

  const openIn = await db.punch.findFirst({
    where: { user_id: user.id, kind: 'IN' },
    orderBy: { at: 'desc' },
    // branch_id so a system checkout is attributed to the branch the shift was
    // actually worked at, which is not always the employee's current branch -
    // nor, once roaming exists, the branch they are standing at now. Its
    // coordinates travel with it for the same reason.
    select: { id: true, at: true, branch_id: true, branch: { select: { lat: true, lng: true } } },
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
    const requiredMin = await requiredMinForArrival(
      db,
      user.id,
      openIn!.at,
      user.branch.day_start_hour,
    );
    const stale =
      input.kind === 'IN'
        ? staleSessionClose({
            arrivalAt: openIn!.at,
            now,
            requiredMin,
            graceMin: user.branch.shift_grace_min,
            dayStartHour: user.branch.day_start_hour,
          })
        : abandonedSessionClose({ arrivalAt: openIn!.at, now, requiredMin });
    if (stale) {
      resolvedStaleSession = true;
      systemClosed = await writeSystemCheckout(db, {
        userId: user.id,
        branchId: openIn!.branch_id,
        branchLat: openIn!.branch?.lat ?? atBranch.lat,
        branchLng: openIn!.branch?.lng ?? atBranch.lng,
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
    await recordBlockedAttempt(db, user, atBranch.id, openIn!.at, input, now);
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
        ...(systemClosedTrip?.back_at ? { systemClosedTripAt: systemClosedTrip.back_at } : {}),
      };
    }
    return { code: 'NOT_PUNCHED_IN' };
  }

  const punch = await db.punch.create({
    data: {
      user_id: user.id,
      branch_id: atBranch.id,
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
    ...(systemClosedTrip?.back_at ? { systemClosedTripAt: systemClosedTrip.back_at } : {}),
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
  user: { id: string },
  branchId: string,
  openInAt: Date,
  input: PunchInput,
  at: Date,
): Promise<void> {
  try {
    await writeBlockedAttempt(db, user, branchId, openInAt, input, at);
  } catch (e) {
    console.error('[punch] could not record blocked attempt', e);
  }
}

async function writeBlockedAttempt(
  db: PrismaClient,
  user: { id: string },
  branchId: string,
  openInAt: Date,
  input: PunchInput,
  at: Date,
): Promise<void> {
  const attempt = await db.blockedPunchAttempt.create({
    data: {
      user_id: user.id,
      branch_id: branchId,
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
