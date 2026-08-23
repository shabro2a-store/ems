import { PrismaClient } from '@prisma/client';
import { todayInBeirut, beirutWeekday } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import { resolveRequiredMin } from './requiredMin';

/**
 * Past this, an open check-in is a forgotten checkout rather than a shift.
 *
 * This is the worker's copy of MAX_OPEN_SESSION_MIN in
 * apps/web/lib/services/coverage.ts, where the dashboard already uses it to
 * stop counting a runaway session. The worker is a separate pnpm package and
 * cannot import from apps/web; autoCloseAbandoned.test.ts pins the two
 * together the same way requiredMin.test.ts pins resolveRequiredMin.
 *
 * It must NOT be the missedCheckout threshold. That fires at the day's
 * required minutes plus the branch grace, which is precisely the moment
 * legitimate overtime starts - closing there would truncate every genuine
 * overrun into the exact shift. 30h is above a full 24h shift_min, so no real
 * shift can reach it.
 */
export const MAX_OPEN_SESSION_MIN = 30 * 60;

export interface AutoCloseAbandonedOpts {
  db?: PrismaClient;
  now?: Date;
}

export interface AutoCloseAbandonedResult {
  closed: number;
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
  const cutoff = new Date(now.getTime() - MAX_OPEN_SESSION_MIN * 60_000);

  const users = await db.user.findMany({
    where: { role: { in: ['EMPLOYEE', 'DRIVER'] } },
    select: { id: true },
  });

  let closed = 0;

  for (const u of users) {
    const lastIn = await db.punch.findFirst({
      where: { user_id: u.id, kind: 'IN' },
      orderBy: { at: 'desc' },
      select: { id: true, at: true, branch_id: true, branch: { select: { lat: true, lng: true } } },
    });
    if (!lastIn) continue;
    if (lastIn.at >= cutoff) continue;
    const laterOut = await db.punch.findFirst({
      where: { user_id: u.id, kind: 'OUT', at: { gt: lastIn.at } },
      select: { id: true },
    });
    if (laterOut) continue;

    // The shift belongs to the Beirut day it started, so the hours owed come
    // from that day - not from today, which may be two days later.
    const inDate = todayInBeirut(lastIn.at);
    const [schedule, override] = await Promise.all([
      db.schedule.findUnique({
        where: { user_id_weekday: { user_id: u.id, weekday: beirutWeekday(lastIn.at) } },
        select: { shift_min: true },
      }),
      db.scheduleOverride.findUnique({
        where: { user_id_date: { user_id: u.id, date: new Date(`${inDate}T00:00:00.000Z`) } },
        select: { kind: true, shift_min: true },
      }),
    ]);
    // A day that owed nothing closes at the check-in itself: zero minutes, zero
    // pay. That is the same ruling applied to a day whose required minutes
    // happen to be zero, and it is deliberately not a reason to leave the
    // session open - an open session is what blocks the employee's next
    // check-in, which is the failure this job exists to end.
    const requiredMin = resolveRequiredMin(override, schedule?.shift_min ?? null);
    const closeAt = new Date(lastIn.at.getTime() + requiredMin * 60_000);
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
            threshold_min: MAX_OPEN_SESSION_MIN,
            reason:
              `Check-in open ${openMin} min with no checkout, past the ${MAX_OPEN_SESSION_MIN} min ` +
              `abandoned-session threshold. Closed at check-in plus the ${requiredMin} min this day ` +
              `required, so the shift is paid and the runaway span is not. Overtime actually worked ` +
              `that night is not included and must be added as a bonus.`,
          },
        },
      });

      return punch;
    });

    if (wrote) closed += 1;
  }

  return { closed };
}
