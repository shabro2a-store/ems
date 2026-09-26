import type { PrismaClient } from '@prisma/client';
import { inBeirut, scheduledToUtc } from 'time';
import { currentPayMonth, isMonthOpen } from './periodLock';

/**
 * From this instant, an advance approved after its month's pay was settled
 * comes out of the next open month. Decisions before it keep the month they
 * were asked for - those months were paid as they stood, and moving an advance
 * into a later month now could take it twice.
 */
export const ADVANCE_LATE_APPROVAL_FROM = new Date('2026-10-01T00:00:00+03:00');

/**
 * The pay month an approved advance comes out of.
 *
 * The month it was asked for, which is what the cap was checked against - as
 * long as that month was still open when the owner said yes. Once it had
 * closed, its pay had gone out without the advance in it, and counting it
 * there meant it was never taken back at all; it comes out of the month that
 * was open at the approval instead.
 *
 * Not simply "the month it was approved": a request on the 30th approved on
 * the 1st would then be weighed against a month with nothing earned in it yet.
 */
export function advancePayMonth(a: { created_at: Date; decided_at: Date | null }): string {
  const asked = inBeirut(a.created_at).date.slice(0, 7);
  if (!a.decided_at || a.decided_at < ADVANCE_LATE_APPROVAL_FROM) return asked;
  return isMonthOpen(asked, a.decided_at) ? asked : currentPayMonth(a.decided_at);
}

/**
 * Approved advances that come out of `month`, optionally leaving one out.
 * Read wide - anything asked for before the month ends and either asked for or
 * decided inside it - and then filed by advancePayMonth, the one definition.
 */
export async function approvedAdvancesForMonth(
  db: PrismaClient,
  userId: string,
  month: string,
  exceptId?: string,
): Promise<Array<{ user_id: string; amount_cent: number; status: 'APPROVED' }>> {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const start = scheduledToUtc(`${month}-01`, '00:00');
  const end = scheduledToUtc(`${next}-01`, '00:00');
  const rows = await db.advance.findMany({
    where: {
      user_id: userId,
      status: 'APPROVED',
      created_at: { lt: end },
      OR: [{ created_at: { gte: start } }, { decided_at: { gte: start } }],
    },
    select: { id: true, user_id: true, amount_cent: true, created_at: true, decided_at: true },
  });
  return rows
    .filter((r) => r.id !== exceptId && advancePayMonth(r) === month)
    .map((r) => ({ user_id: r.user_id, amount_cent: r.amount_cent, status: 'APPROVED' as const }));
}
