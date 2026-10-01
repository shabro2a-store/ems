import type { PrismaClient } from '@prisma/client';
import { hourlyRateAt, monthRangeBeirut, monthRangeUtc } from './payout';
import { overtimeRateOn } from './overtime';

/**
 * The hourly rate printed beside each person's month - on the payroll screen
 * and in the PDF, which must agree. The rate in force when the month ended,
 * which is what its later work was paid at; before a person's first rate, the
 * one they started on (hourlyRateAt); with no history at all, their current
 * rate. The PDF used to print $0 there and the screen today's rate.
 */
export async function monthEndRates(
  db: Pick<PrismaClient, 'rateChange'>,
  users: Array<{ id: string; hourly_rate_cent: number }>,
  month: string,
): Promise<Map<string, number>> {
  const lastInstant = new Date(monthRangeBeirut(month).end.getTime() - 1);
  const history = await db.rateChange.findMany({
    where: { user_id: { in: users.map((u) => u.id) } },
    orderBy: { effective_from: 'asc' },
    select: { user_id: true, rate_cent: true, effective_from: true },
  });
  const byUser = new Map<string, Array<{ rate_cent: number; effective_from: Date }>>();
  for (const rc of history) {
    const list = byUser.get(rc.user_id) ?? [];
    list.push(rc);
    byUser.set(rc.user_id, list);
  }
  const out = new Map<string, number>();
  for (const u of users) {
    const rates = byUser.get(u.id);
    out.set(u.id, rates && rates.length > 0 ? hourlyRateAt(rates, lastInstant) : u.hourly_rate_cent);
  }
  return out;
}

/**
 * The overtime rate beside the hourly one, on the payroll screen and in the
 * PDF: the one in force on the month's last day, or null for "the hourly rate".
 */
export async function monthEndOvertimeRates(
  db: Pick<PrismaClient, 'overtimeRateChange'>,
  userIds: string[],
  month: string,
): Promise<Map<string, number | null>> {
  const lastDay = new Date(monthRangeUtc(month).end.getTime() - 86_400_000).toISOString().slice(0, 10);
  const history = await db.overtimeRateChange.findMany({
    where: { user_id: { in: userIds } },
    select: { user_id: true, rate_cent: true, effective_from: true },
  });
  const out = new Map<string, number | null>();
  for (const id of userIds) {
    out.set(id, overtimeRateOn(history.filter((h) => h.user_id === id), lastDay));
  }
  return out;
}
