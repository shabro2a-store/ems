import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';

/**
 * How long a receipt photo is kept. Its job is done once the owner has
 * confirmed the day it belongs to, and a day confirms itself 48 hours after
 * its last trip at the latest (tripReview.ts in the web app) - so a week on,
 * every photo is dead weight in the database. The trip keeps
 * receipt_taken_at as the record that there was one.
 */
export const RECEIPT_KEEP_DAYS = 7;

export interface WipeReceiptsOpts {
  db?: PrismaClient;
  now?: Date;
}

export async function runWipeReceipts(opts: WipeReceiptsOpts = {}): Promise<{ wiped: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECEIPT_KEEP_DAYS * 86_400_000);
  const { count } = await db.tripReceipt.deleteMany({ where: { trip: { out_at: { lt: cutoff } } } });
  if (count > 0) console.log(`[wipeReceipts] wiped ${count} receipt photo(s) older than ${RECEIPT_KEEP_DAYS} days`);
  return { wiped: count };
}
