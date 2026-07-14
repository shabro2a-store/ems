import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface EndOfDayWatcherOpts {
  db?: PrismaClient;
  now?: Date;
  notifier: Notifier;
}

export interface EndOfDayWatcherResult {
  flags_scanned: number;
  notified: number;
}

export async function runEndOfDayWatcher(
  opts: EndOfDayWatcherOpts,
): Promise<EndOfDayWatcherResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const flags = await db.flag.findMany({
    where: { kind: 'WATCHED', notified_at: null },
    include: { user: true },
  });

  let notified = 0;
  const flags_scanned = flags.length;

  for (const f of flags) {
    const since_h = Math.floor((now.getTime() - f.created_at.getTime()) / (60 * 60_000));
    const since_min = Math.floor((now.getTime() - f.created_at.getTime()) / 60_000);
    const hhmm = `${String(f.created_at.getUTCHours()).padStart(2, '0')}:${String(f.created_at.getUTCMinutes()).padStart(2, '0')}`;

    await opts.notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'watched.unresolved',
      context: {
        flag_id: f.id,
        user: f.user ? { id: f.user.id, username: f.user.username } : null,
        since_hours: since_h,
        since_min: since_min,
        message: f.user
          ? `Employee ${f.user.username} never punched in today (watched since ${hhmm}).`
          : `Watched flag ${f.id} never resolved.`,
      },
    });

    await db.flag.update({
      where: { id: f.id },
      data: { notified_at: now },
    });
    notified += 1;
  }

  return { flags_scanned, notified };
}