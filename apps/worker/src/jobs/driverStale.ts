import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface DriverStaleOpts {
  db?: PrismaClient;
  now?: Date;
  notifier: Notifier;
}

export interface DriverStaleResult {
  trips_scanned: number;
  notified: number;
}

const STALE_MS = 4 * 60 * 60_000;

export async function runDriverStale(
  opts: DriverStaleOpts,
): Promise<DriverStaleResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const openTrips = await db.trip.findMany({
    where: { back_at: null },
    include: { driver: true, branch: true },
  });

  let notified = 0;
  const trips_scanned = openTrips.length;

  for (const t of openTrips) {
    if (now.getTime() - t.out_at.getTime() < STALE_MS) continue;

    const sinceH = Math.floor((now.getTime() - t.out_at.getTime()) / (60 * 60_000));
    await opts.notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'driver.stale',
      context: {
        trip_id: t.id,
        driver: { id: t.driver_id, username: t.driver.username },
        branch: { id: t.branch_id, name: t.branch.name },
        since_hours: sinceH,
        message: `Driver ${t.driver.username} marked OUT for ${sinceH}h+, no BACK press. Phone dead or stranded.`,
      },
    });
    notified += 1;
  }

  return { trips_scanned, notified };
}