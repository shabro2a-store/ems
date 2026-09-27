import type { PrismaClient } from '@prisma/client';
import { hourlyRateAt, monthRangeBeirut } from './payout';

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
