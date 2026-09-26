import type { PrismaClient } from '@prisma/client';
import { punchLockKey } from './punch';

/**
 * Delete a system checkout and mark its arrival revoked - unless the employee
 * has punched since.
 *
 * Reopening a shift is only safe while nothing has happened after it. Once they
 * have checked in again, every reader pairs the reopened arrival with the NEW
 * shift's checkout: in Monday 07:00, system out 15:00, in again Tuesday 07:00,
 * out 15:00 - revoke, and payroll pays 32 hours on Monday, nothing on Tuesday,
 * and a day of overtime besides. Correcting the checkout's time is what that
 * case needs, and the refusal says so.
 *
 * Asked under the per-person punch lock, so a check-in landing between the
 * question and the delete waits for the answer instead of slipping past it.
 */
export async function revokeSystemCheckout(
  db: PrismaClient,
  args: { userId: string; outId: string; outAt: Date; arrivalId: string; revokedAt: Date },
): Promise<{ revoked: true } | { refused: 'PUNCHED_SINCE'; at: Date }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${punchLockKey(args.userId)}::bigint)`;
    const since = await tx.punch.findFirst({
      where: { user_id: args.userId, at: { gt: args.outAt } },
      orderBy: { at: 'asc' },
      select: { at: true },
    });
    if (since) return { refused: 'PUNCHED_SINCE' as const, at: since.at };
    await tx.punch.delete({ where: { id: args.outId } });
    await tx.punch.update({ where: { id: args.arrivalId }, data: { auto_close_revoked_at: args.revokedAt } });
    return { revoked: true as const };
  });
}
