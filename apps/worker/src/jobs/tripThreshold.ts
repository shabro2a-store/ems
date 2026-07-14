import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface TripThresholdOpts {
  db?: PrismaClient;
  now?: Date;
  notifier: Notifier;
}

export interface TripThresholdResult {
  trips_scanned: number;
  notified: number;
}

export async function runTripThreshold(
  opts: TripThresholdOpts,
): Promise<TripThresholdResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const openTrips = await db.trip.findMany({
    where: { back_at: null },
    include: { driver: true, branch: true },
  });

  let notified = 0;
  const trips_scanned = openTrips.length;

  for (const t of openTrips) {
    const thresholdMs = t.branch.trip_threshold_min * 60_000;
    if (now.getTime() - t.out_at.getTime() < thresholdMs) continue;
    if (t.threshold_alerted_at) continue;

    await db.trip.update({
      where: { id: t.id },
      data: { threshold_alerted_at: now, over_threshold: true },
    });

    const sinceMin = Math.floor((now.getTime() - t.out_at.getTime()) / 60_000);
    await opts.notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'trip.over_threshold',
      context: {
        trip_id: t.id,
        driver: { id: t.driver_id, username: t.driver.username },
        branch: { id: t.branch_id, name: t.branch.name },
        since_min: sinceMin,
        message: `[Driver] ${t.driver.username} out ${sinceMin} min and counting.`,
      },
    });
    notified += 1;
  }

  return { trips_scanned, notified };
}