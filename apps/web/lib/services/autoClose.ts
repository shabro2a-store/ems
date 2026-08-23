import type { PrismaClient, Punch } from '@prisma/client';
import { inBeirut, beirutWeekday } from 'time';
import { requiredMinFor } from './coverage';

/**
 * When a check-in nobody closed is deemed to have ended.
 *
 * The owner's rule is arrival + the hours that day owed: the system pays the
 * shift and nothing more, because a punch nobody made cannot say how long they
 * stayed.
 *
 * The floor of one minute is not a rounding nicety, it is the difference
 * between a checkout and a lockout. Every reader of "is this session still
 * open" asks for an OUT strictly after the IN (`at: { gt: arrival }`) - the
 * punch guard, this job's own guard, currentOpenIn, the dev route. A checkout
 * written at the exact instant of the arrival satisfies none of them, so the
 * session stays open, the job writes another one on its next tick, and the
 * employee can never clock in again. That is reachable in normal use: a day
 * with 0 required minutes is what staff have when they come in on a day off to
 * help during a rush, and nothing alerts on it because missedCheckout skips
 * days requiring nothing.
 *
 * One minute pays a few cents where the ruling says zero. That is the price of
 * the record being visible at all, and it is the smaller of the two errors.
 */
export function systemCheckoutAt(arrivalAt: Date, requiredMin: number): Date {
  return new Date(arrivalAt.getTime() + Math.max(requiredMin, 1) * 60_000);
}

export interface StaleSessionCheck {
  /** The system checkout that would be written. */
  closeAt: Date;
  requiredMin: number;
}

/**
 * Whether an open check-in belongs to a shift-day that is over, and so may be
 * closed by the system rather than by the employee.
 *
 * Two conditions, and both are needed:
 *
 *  - the arrival is on an **earlier Beirut calendar day** than now. A second IN
 *    tap on the same day is a duplicate, not a new shift, and must be refused -
 *    silently closing a shift somebody is in the middle of would take their
 *    hours.
 *  - the session has already run past its own `required + grace`, the same
 *    threshold `missedCheckout` uses to call it suspicious. Without this, a
 *    21:00-07:00 night shift would be "an earlier calendar day" from midnight
 *    onwards, and a stray tap at 02:00 would close a shift in progress.
 *
 * The close must also land strictly before `now`, or we are back to writing a
 * checkout no guard can see - reachable when a 0-required session opened just
 * before midnight.
 */
export function staleSessionClose(args: {
  arrivalAt: Date;
  now: Date;
  requiredMin: number;
  graceMin: number;
}): StaleSessionCheck | null {
  if (inBeirut(args.arrivalAt).date >= inBeirut(args.now).date) return null;
  const elapsedMin = Math.floor((args.now.getTime() - args.arrivalAt.getTime()) / 60_000);
  if (elapsedMin <= args.requiredMin + args.graceMin) return null;
  const closeAt = systemCheckoutAt(args.arrivalAt, args.requiredMin);
  if (closeAt.getTime() >= args.now.getTime()) return null;
  return { closeAt, requiredMin: args.requiredMin };
}

/** The hours the Beirut day of this arrival owed, resolved as payroll resolves it. */
export async function requiredMinForArrival(
  db: PrismaClient,
  userId: string,
  arrivalAt: Date,
): Promise<number> {
  const date = inBeirut(arrivalAt).date;
  const [schedule, override] = await Promise.all([
    db.schedule.findUnique({
      where: { user_id_weekday: { user_id: userId, weekday: beirutWeekday(arrivalAt) } },
      select: { shift_min: true },
    }),
    db.scheduleOverride.findUnique({
      where: { user_id_date: { user_id: userId, date: new Date(`${date}T00:00:00.000Z`) } },
      select: { kind: true, shift_min: true },
    }),
  ]);
  return requiredMinFor(override, schedule?.shift_min ?? null);
}

/**
 * Write the checkout an abandoned check-in never got, with the record of why.
 *
 * Re-reads for a real checkout inside the transaction so a live punch always
 * wins and two writers cannot both close the same session.
 */
export async function writeSystemCheckout(
  db: PrismaClient,
  args: {
    userId: string;
    branchId: string;
    branchLat: number;
    branchLng: number;
    arrivalAt: Date;
    arrivalPunchId: string;
    closeAt: Date;
    requiredMin: number;
    now: Date;
    trigger: 'abandoned_sweep' | 'blocked_check_in';
    reason: string;
  },
): Promise<Punch | null> {
  return db.$transaction(async (tx) => {
    const raced = await tx.punch.findFirst({
      where: { user_id: args.userId, kind: 'OUT', at: { gt: args.arrivalAt } },
      select: { id: true },
    });
    if (raced) return null;

    const punch = await tx.punch.create({
      data: {
        user_id: args.userId,
        branch_id: args.branchId,
        kind: 'OUT',
        at: args.closeAt,
        // The branch's own coordinates, not the employee's: nobody stood
        // anywhere to make this punch. system_generated is what says so.
        lat: args.branchLat,
        lng: args.branchLng,
        accuracy_m: 0,
        device_fp: 'system',
        ip: 'system',
        system_generated: true,
      },
    });

    await tx.auditLog.create({
      data: {
        // Not a user id: no person did this. AuditLog.actor_id has no foreign
        // key, so the literal reads honestly in the log.
        actor_id: 'system',
        action: 'punch.auto_close',
        entity: 'Punch',
        entity_id: punch.id,
        after_json: {
          user_id: args.userId,
          branch_id: args.branchId,
          kind: 'OUT',
          at: punch.at.toISOString(),
          system_generated: true,
          trigger: args.trigger,
          in_punch_id: args.arrivalPunchId,
          in_at: args.arrivalAt.toISOString(),
          open_min: Math.floor((args.now.getTime() - args.arrivalAt.getTime()) / 60_000),
          required_min: args.requiredMin,
          reason: args.reason,
        },
      },
    });

    return punch;
  });
}
