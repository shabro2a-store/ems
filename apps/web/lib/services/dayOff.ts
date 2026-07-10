import { todayInBeirut } from 'time';
import { prisma } from '@/lib/db/prisma';

export async function userHasApprovedDayOffToday(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const dateStr = todayInBeirut(now);
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    const dateLocal = new Date(`${dateStr}T00:00:00`);
    const override = await prisma.scheduleOverride.findUnique({
      where: { user_id_date: { user_id: userId, date: dateLocal } },
    });
    return override?.kind === 'DAY_OFF';
  }
  const override = await prisma.scheduleOverride.findUnique({
    where: { user_id_date: { user_id: userId, date } },
  });
  return override?.kind === 'DAY_OFF';
}
