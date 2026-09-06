import type { PrismaClient, Punch } from '@prisma/client';
import { shiftDateOf, shiftWeekdayOf } from 'time';
import { requiredMinFor } from './coverage';

/**
 * How long an open check-in may run before the system decides nobody is going
 * to close it.
 *
 * Deliberately NOT `MAX_OPEN_SESSION_MIN` (30h), which is a different question:
 * that one asks "may this session still be counted in today's hours", and it
 * sits above a full 24h shift_min so no real shift is ever clamped by it.
 *
 * Twenty hours is the owner's number, and it is a judgement, not a derivation.
 * A 34h double cover and a forgotten checkout are INDISTINGUISHABLE from the
 * arrival alone - no threshold can separate them, because the only thing that
 * can is the employee's own OUT punch, which by definition has not arrived yet.
 * So the choice is which error to make by default, and 20h makes the one that
 * is visible: it closes early, tells the owner, and gives him a Revoke that
 * puts the session back. The 30h version made the invisible error instead - it
 * waited, said nothing, and the truncation only surfaced in a payroll figure
 * nobody could trace back to a night three weeks earlier.
 */
export const AUTO_CLOSE_AFTER_MIN = 20 * 60;

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
 * Whether an open check-in has stopped being a shift at all.
 *
 * The only basis on which the system may overrule a punch the employee is
 * making right now, and the sweep and the clock-out path share it so the two
 * can never disagree about whether a session is still a shift.
 *
 * Note what `revoked` does to THIS path in particular: once the owner has
 * revoked, an employee who worked 34 hours and clocks out at 34 hours has
 * their real punch written, instead of being handed the 17h the system had
 * already decided for them. That is the whole point of the button.
 *
 * NOT `staleSessionClose`. That fires at `required + grace`, which is exactly
 * when legitimate overtime begins - the reason autoCloseAbandoned refuses to
 * trigger there. Applying it to a clock-out discarded the employee's own punch
 * and paid them the scheduled hours instead: a night worker on a 10h shift who
 * clocked out at 07:16 worked 616 minutes, was paid 600, and the record said
 * they left at 07:00. Between `required + grace` and 30h an overrun is
 * plausibly real work, and the overtime notice is the control the owner
 * already has for it.
 */
export function abandonedSessionClose(args: {
  arrivalAt: Date;
  now: Date;
  requiredMin: number;
  /**
   * The owner has already thrown away a checkout written for this arrival.
   *
   * He has looked at this exact session and said the employee really was still
   * there, so the guess must not be made again - on the sweep's next tick ten
   * minutes later, or against the employee's own clock-out. Without this the
   * Revoke button does nothing you can keep: the row comes straight back.
   */
  revoked?: boolean;
}): StaleSessionCheck | null {
  if (args.revoked) return null;
  const elapsedMin = Math.floor((args.now.getTime() - args.arrivalAt.getTime()) / 60_000);
  if (elapsedMin <= AUTO_CLOSE_AFTER_MIN) return null;
  const closeAt = systemCheckoutAt(args.arrivalAt, args.requiredMin);
  // Not always true now the threshold is 20h: a 24h shift_min closes at
  // arrival + 24h, which is still in the future at 20h. Such a session simply
  // is not closed yet, and the next tick reconsiders it. Without this guard it
  // would be closed into the future, where no "is this open" query can see the
  // checkout - see systemCheckoutAt.
  if (closeAt.getTime() >= args.now.getTime()) return null;
  return { closeAt, requiredMin: args.requiredMin };
}

/**
 * Whether an open check-in belongs to a shift-day that is over, and so may be
 * closed when the employee starts a NEW shift.
 *
 * Deliberately NOT suppressed by `auto_close_revoked_at`. A revoke says "he
 * was still working", and a check-in the next day is the proof that he no
 * longer is. If a revoke silenced this path too, the arrival could never be
 * closed by anything and the employee would be locked out of clocking in for
 * good - the exact failure the whole auto-close exists to prevent.
 *
 * Check-in only. The new check-in is itself the evidence the old shift ended,
 * and nothing the employee made is discarded - their IN is still written at
 * `now`. On a clock-out the employee is standing there asserting the truth
 * about their own shift, and the system must not overrule them; that path uses
 * abandonedSessionClose.
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
  /** The branch's working-day start hour; 0 is the calendar day. */
  dayStartHour?: number;
}): StaleSessionCheck | null {
  // "An earlier day" means an earlier WORKING day. On a branch whose day starts
  // at 06:00, somebody who clocked in at 23:00 and taps again at 01:00 is still
  // inside the same shift-day and must be refused, not silently closed.
  const dayStart = args.dayStartHour ?? 0;
  if (shiftDateOf(args.arrivalAt, dayStart) >= shiftDateOf(args.now, dayStart)) return null;
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
  dayStartHour = 0,
): Promise<number> {
  const date = shiftDateOf(arrivalAt, dayStartHour);
  const [schedule, override] = await Promise.all([
    db.schedule.findUnique({
      where: { user_id_weekday: { user_id: userId, weekday: shiftWeekdayOf(arrivalAt, dayStartHour) } },
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
    trigger: 'abandoned_sweep' | 'new_check_in' | 'stale_clock_out';
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

    // A day that owed nothing goes entirely unwatched: missedCheckout skips
    // 0-required days, watchedDetector skips them too, and deltaMin >= 0 means
    // no penalty row - so a day-off helper who forgot to clock out is paid
    // three cents for an evening and nobody is ever told. The one-minute floor
    // is the lockout cure, not a notice. This is the notice.
    if (args.requiredMin === 0) {
      await tx.flag.create({
        data: {
          kind: 'MISSED_CHECKOUT',
          user_id: args.userId,
          branch_id: args.branchId,
          context_json: {
            shift_min: 0,
            over_min: Math.floor((args.now.getTime() - args.arrivalAt.getTime()) / 60_000),
            zero_required_auto_close: true,
            in_at: args.arrivalAt.toISOString(),
            closed_at: punch.at.toISOString(),
          },
        },
      });
    }

    return punch;
  });
}
