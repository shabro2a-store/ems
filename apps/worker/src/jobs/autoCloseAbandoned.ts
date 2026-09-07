import { PrismaClient } from '@prisma/client';
import { beirutWeekday, inBeirut } from 'time';
import type { Notifier } from 'notify';
import { prisma as defaultPrisma } from '../db/prisma';
import { resolveRequiredMin } from './requiredMin';
import { resolveDayStartHour, resolveWorkingDays } from './dayStart';

/**
 * Past this, an open check-in is treated as a forgotten checkout.
 *
 * The worker's copy of AUTO_CLOSE_AFTER_MIN in
 * apps/web/lib/services/autoClose.ts, which is the definition of record; the
 * worker is a separate pnpm package and cannot import from apps/web, so
 * autoCloseAbandoned.test.ts pins the two together the way requiredMin.test.ts
 * pins resolveRequiredMin.
 *
 * It must NOT be the missedCheckout threshold. That fires at the day's
 * required minutes plus the branch grace, which is precisely the moment
 * legitimate overtime starts - closing there would truncate every genuine
 * overrun into the exact shift.
 *
 * Nor is it MAX_OPEN_SESSION_MIN (30h) in coverage.ts, which answers a
 * different question: whether a session may still be counted in today's hours.
 * That one has to sit above a full 24h shift_min. This one is a judgement
 * about when to stop waiting, and 20h is the owner's. It will reach real
 * double covers - a 34h double and a forgotten punch look identical from the
 * arrival alone - which is why closing now notifies him and why he can revoke
 * it. Closing early and loudly is the recoverable error; closing late and
 * silently is not.
 */
export const AUTO_CLOSE_AFTER_MIN = 20 * 60;

/**
 * When a check-in nobody closed is deemed to have ended: arrival + the hours
 * that day owed, floored at one minute.
 *
 * The worker's copy of systemCheckoutAt in apps/web/lib/services/autoClose.ts,
 * which is the definition of record and which the blocked-check-in path uses
 * too. The worker is a separate pnpm package and cannot import from apps/web;
 * autoCloseAbandoned.test.ts pins the two against the same table of cases.
 *
 * The one-minute floor is the difference between a checkout and a lockout -
 * see the original for why. Do not remove it here without removing it there,
 * and do not remove it there.
 */
export function systemCheckoutAt(arrivalAt: Date, requiredMin: number): Date {
  return new Date(arrivalAt.getTime() + Math.max(requiredMin, 1) * 60_000);
}

export interface AutoCloseAbandonedOpts {
  db?: PrismaClient;
  now?: Date;
  // Optional so the tests and any manual run can leave it out; the worker
  // always passes one. A missing notifier must never stop a checkout being
  // written - the punch is the thing that unblocks the employee's next
  // check-in, the message is only how the owner hears about it.
  notifier?: Notifier;
}

export interface AutoCloseAbandonedResult {
  closed: number;
  notified: number;
}

/**
 * Write the checkout an abandoned check-in never got.
 *
 * An employee who forgets to punch out is usually caught within a day, because
 * their next check-in is refused - but the punch itself is never closed, and
 * whoever closes it eventually gets paid the whole runaway span. Somebody who
 * does not come back the next day (a day off) has no resolution at all.
 *
 * The written checkout is check-in + that day's required minutes: the owner's
 * ruling is that the system pays the shift and nothing more. Genuine overtime
 * worked that night is his to add as a bonus and the employee's to report - it
 * is unknowable from a punch that was never made, and guessing it high pays
 * for hours nobody worked.
 */
export async function runAutoCloseAbandoned(
  opts: AutoCloseAbandonedOpts = {},
): Promise<AutoCloseAbandonedResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - AUTO_CLOSE_AFTER_MIN * 60_000);

  const users = await db.user.findMany({
    // Deliberately not filtered on is_active. A deactivated employee cannot
    // punch again, so no lockout is at stake - but their last session may still
    // be open, and payroll still has to pay that month correctly. Leaving it
    // open is what pays a runaway span whenever somebody eventually closes it.
    where: { role: { in: ['EMPLOYEE', 'DRIVER'] } },
    select: {
      id: true,
      username: true,
      day_start_hour: true,
      branch: { select: { name: true } },
    },
  });

  let closed = 0;
  let notified = 0;

  for (const u of users) {
    const lastIn = await db.punch.findFirst({
      where: { user_id: u.id, kind: 'IN' },
      orderBy: { at: 'desc' },
      select: {
        id: true,
        at: true,
        branch_id: true,
        auto_close_revoked_at: true,
        branch: { select: { lat: true, lng: true } },
      },
    });
    if (!lastIn) continue;
    if (lastIn.at >= cutoff) continue;
    // The owner has already thrown away a checkout written for this arrival: he
    // looked at this session and said the employee really was still there. This
    // job runs every ten minutes, so without this check the row he revoked
    // would simply be written again before he had finished reading the message
    // telling him about it.
    //
    // It cannot strand anyone. A revoked arrival is still closed by
    // staleSessionClose the moment they clock in again, which is the evidence
    // that the shift is genuinely over.
    if (lastIn.auto_close_revoked_at) continue;
    const laterOut = await db.punch.findFirst({
      where: { user_id: u.id, kind: 'OUT', at: { gt: lastIn.at } },
      select: { id: true },
    });
    if (laterOut) continue;

    // The shift belongs to the WORKING day it started - which on a branch whose
    // day starts at 06:00 is not the calendar day for anyone clocking in before
    // dawn. Not today either, which may be two days later.
    // The employee's own boundary, not the branch the shift was worked at: a
    // roaming employee covering elsewhere is still paid against their own day,
    // so reading the host branch's hour would close the shift onto a different
    // day than payroll will pay it on.
    const dayStart = resolveDayStartHour(u);
    // The working day this arrival is on, asked of the same rule payroll asks.
    // Three days of punches around it, because the answer depends on the rest
    // before it and on which shift already claimed the date.
    const nearby = await db.punch.findMany({
      where: { user_id: u.id, at: { gte: new Date(lastIn.at.getTime() - 3 * 86_400_000), lte: lastIn.at } },
      orderBy: { at: 'asc' },
      select: { kind: true, at: true },
    });
    const dayLabels = resolveWorkingDays(nearby, dayStart);
    const arrivalIdx = nearby.findIndex((p) => p.kind === 'IN' && p.at.getTime() === lastIn.at.getTime());
    const inDate =
      (arrivalIdx >= 0 ? dayLabels[arrivalIdx] : null) ??
      resolveWorkingDays([{ kind: 'IN', at: lastIn.at }], dayStart)[0]!;
    const [schedule, override] = await Promise.all([
      db.schedule.findUnique({
        // From the LABEL, not the arrival instant: under the rest rule a shift
        // starting at 23:58 can be filed on the following date, and the weekday
        // must be the one the day is filed under or this reads a different
        // day's hours than payroll does.
        where: { user_id_weekday: { user_id: u.id, weekday: beirutWeekday(new Date(`${inDate}T12:00:00.000Z`)) } },
        select: { shift_min: true },
      }),
      db.scheduleOverride.findUnique({
        where: { user_id_date: { user_id: u.id, date: new Date(`${inDate}T00:00:00.000Z`) } },
        select: { kind: true, shift_min: true },
      }),
    ]);
    // A day that owed nothing still has to close - an open session is what
    // blocks the employee's next check-in, which is the failure this job exists
    // to end - and it closes one minute after the arrival rather than at it.
    // See systemCheckoutAt: a zero-length checkout is invisible to every guard
    // that asks for an OUT strictly after the IN, so the session would stay
    // open and this job would write another one every ten minutes forever.
    const requiredMin = resolveRequiredMin(override, schedule?.shift_min ?? null);
    const closeAt = systemCheckoutAt(lastIn.at, requiredMin);
    const openMin = Math.floor((now.getTime() - lastIn.at.getTime()) / 60_000);

    const wrote = await db.$transaction(async (tx) => {
      // Re-read inside the transaction: a real checkout landing between the
      // scan and the write must win, and two overlapping runs of this job must
      // not both write a checkout for the same session.
      const raced = await tx.punch.findFirst({
        where: { user_id: u.id, kind: 'OUT', at: { gt: lastIn.at } },
        select: { id: true },
      });
      if (raced) return null;

      const punch = await tx.punch.create({
        data: {
          user_id: u.id,
          branch_id: lastIn.branch_id,
          kind: 'OUT',
          at: closeAt,
          // The branch's own coordinates, not the employee's: nobody stood
          // anywhere to make this punch. system_generated is what says so.
          lat: lastIn.branch?.lat ?? 0,
          lng: lastIn.branch?.lng ?? 0,
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
            user_id: u.id,
            branch_id: lastIn.branch_id,
            kind: 'OUT',
            at: punch.at.toISOString(),
            system_generated: true,
            in_punch_id: lastIn.id,
            in_at: lastIn.at.toISOString(),
            open_min: openMin,
            required_min: requiredMin,
            threshold_min: AUTO_CLOSE_AFTER_MIN,
            reason:
              `Check-in open ${openMin} min with no checkout, past the ${AUTO_CLOSE_AFTER_MIN} min ` +
              `abandoned-session threshold. Closed at check-in plus the ${requiredMin} min this day ` +
              `required, so the shift is paid and the runaway span is not. Overtime actually worked ` +
              `that night is not included and must be added as a bonus.`,
          },
        },
      });

      // Mirrors writeSystemCheckout in apps/web/lib/services/autoClose.ts. A
      // day that owed nothing is watched by nothing: missedCheckout and
      // watchedDetector both skip 0-required days, and deltaMin >= 0 raises no
      // penalty - so a day-off helper who forgot to clock out is paid three
      // cents for an evening in total silence. This is the notice.
      if (requiredMin === 0) {
        await tx.flag.create({
          data: {
            kind: 'MISSED_CHECKOUT',
            user_id: u.id,
            branch_id: lastIn.branch_id,
            context_json: {
              shift_min: 0,
              over_min: openMin,
              zero_required_auto_close: true,
              in_at: lastIn.at.toISOString(),
              closed_at: punch.at.toISOString(),
            },
          },
        });
      }

      return punch;
    });

    if (!wrote) continue;
    closed += 1;

    // Tell the owner. missedCheckout already warned him hours ago that somebody
    // was still clocked in - but that message asks a question ("overtime, or
    // forgot to punch out?") and this is the answer being decided FOR him, in
    // money, by a job running at 03:00. Writing a paid checkout in silence is
    // the part he cannot review, because nothing on the dashboard distinguishes
    // it from a punch the employee made.
    //
    // Sent after the transaction, and never allowed to fail it: Telegram being
    // down must not roll back the checkout that unblocks tomorrow's shift.
    const hours = Math.round((requiredMin / 60) * 10) / 10;
    const { date: inDateB, hhmm: inHhmm } = inBeirut(lastIn.at);
    const { date: outDateB, hhmm: outHhmm } = inBeirut(wrote.at);
    if (!opts.notifier) continue;
    try {
      await opts.notifier.send({
        channel: 'telegram',
        recipient: 'admin',
        template: 'punch.auto_close',
        context: {
          user: { id: u.id, username: u.username },
          branch: u.branch ? { name: u.branch.name } : null,
          punch_id: wrote.id,
          in_at: lastIn.at.toISOString(),
          closed_at: wrote.at.toISOString(),
          open_min: openMin,
          required_min: requiredMin,
          message:
            `${u.username}${u.branch ? `, ${u.branch.name}` : ''} never punched out from ` +
            `${inDateB} ${inHhmm}. The system has closed it at ${outDateB} ${outHhmm} and paid ` +
            `the ${hours}h that day required. Any overtime actually worked is NOT included - ` +
            `add it as a bonus if it was real. If he was covering a double and is ` +
            `still there, Revoke it on the punches page and his own punch-out will count.`,
        },
      });
      notified += 1;
    } catch {
      // Already written and already audited. Losing the message is not a reason
      // to retry the punch, and this job runs again in ten minutes.
    }
  }

  return { closed, notified };
}
