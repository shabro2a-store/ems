import * as Sentry from '@sentry/node';
import type { Notifier } from 'notify';
import { SHOP_TZ } from 'time';
import { runWatchedDetector } from './jobs/watchedDetector';
import { runMissedCheckout } from './jobs/missedCheckout';
import { runAutoCloseAbandoned } from './jobs/autoCloseAbandoned';
import { runAutoCloseAbandonedTrips } from './jobs/autoCloseAbandonedTrips';
import { runTripThreshold } from './jobs/tripThreshold';
import { runDriverStale } from './jobs/driverStale';
import { runEndOfDayWatcher } from './jobs/endOfDayWatcher';
import { runDailySummary } from './jobs/dailySummary';
import { runRingRepeater } from './jobs/ringRepeater';
import { runWipeReceipts } from './jobs/wipeReceipts';
import { runPrune } from './jobs/prune';
import { runBackupWatch } from './jobs/backupWatch';
import { beat } from './heartbeat';
import { prisma } from './db/prisma';

/** The part of node-cron this file uses, so the table can be read without starting it. */
export interface CronLike {
  schedule(expression: string, fn: () => unknown, options?: { timezone?: string }): unknown;
}

const running = new Set<string>();

// A job failing on every tick - the ring repeater runs every five seconds -
// would send Sentry 17,000 copies of one outage a day and use up a free plan in
// an afternoon. One report per job per hour while it keeps failing; the first
// failure after a recovery is reported at once.
const REPORT_EVERY_MS = 60 * 60_000;
const lastReported = new Map<string, number>();

function report(name: string, e: unknown): void {
  const last = lastReported.get(name);
  const now = Date.now();
  if (last !== undefined && now - last < REPORT_EVERY_MS) return;
  lastReported.set(name, now);
  Sentry.captureException(e, { tags: { job: name } });
}

/**
 * One run of a job at a time. node-cron starts a job on its tick whether or not
 * the last run has finished, so a slow one - a big sweep, a slow database -
 * overlapped the next: two sweeps writing the same checkouts, two ring
 * repeaters pushing twice. A tick that finds its job still going skips; the
 * next tick runs as usual. A failed run is logged (and sent to Sentry when
 * SENTRY_DSN is set; without it this is a no-op) and does not stop the next.
 */
export function guarded(name: string, fn: () => Promise<unknown>) {
  return async () => {
    if (running.has(name)) {
      console.warn(`[cron:${name}] still running from the last tick - skipped`);
      return;
    }
    running.add(name);
    try {
      await fn();
      lastReported.delete(name);
    } catch (e) {
      console.error(`[cron:${name}]`, e);
      report(name, e);
    } finally {
      running.delete(name);
    }
  };
}

export function registerJobs(cron: CronLike, notifier: Notifier): void {
  // Every line is read on the shop's clock. The container's is UTC, so without
  // this "0 23" was 02:00 Beirut in summer and 01:00 in winter, and the evening
  // summary described the day that had just begun.
  const at = (expression: string, name: string, fn: () => Promise<unknown>) =>
    cron.schedule(expression, guarded(name, fn), { timezone: SHOP_TZ });

  // Six fields: this one runs every five SECONDS. A ring has to behave like a
  // phone ringing rather than a single notification nobody heard, and the driver
  // is standing in a shop waiting - a one-minute tick is not a ring, it is a
  // reminder. The query reads the partial index driver_call_unanswered, which holds
  // only the calls nobody has answered, not every call ever made.
  at('*/5 * * * * *', 'ringRepeater', () => runRingRepeater());
  // What the container healthcheck reads: a real query, then the time. Without
  // it the check was `process.exit(0)` and passed whatever the worker was doing.
  at('*/30 * * * * *', 'heartbeat', () => beat(prisma));
  // Hourly, not once at a fixed clock time. The job judges the last working day
  // that has fully ended, and a working day ends where the person's own rest
  // says it does, not at an hour anybody could line a clock up against. Running
  // every hour reports an absence within the hour whatever the day and whatever
  // the season. The job is idempotent - one flag per user per working day, keyed
  // on the day itself.
  at('10 * * * *', 'watchedDetector', () => runWatchedDetector());
  at('*/1 * * * *', 'missedCheckout', () => runMissedCheckout({ notifier }));
  at('*/1 * * * *', 'tripThreshold', () => runTripThreshold({ notifier }));
  // Every 10 min is plenty for a 20h threshold, and keeps a job that writes
  // punches off the same minute tick as the read-only alerting jobs.
  at('*/10 * * * *', 'autoCloseAbandoned', () => runAutoCloseAbandoned({ notifier }));
  // Same tick, same reason: a trip nobody closed blocks the driver's punches and
  // their dispatch, and a driver who never comes back cannot clear it themselves.
  at('*/10 * * * *', 'autoCloseAbandonedTrips', () => runAutoCloseAbandonedTrips());
  at('*/30 * * * *', 'driverStale', () => runDriverStale({ notifier }));
  at('30 23 * * *', 'endOfDayWatcher', () => runEndOfDayWatcher({ notifier }));
  at('0 23 * * *', 'dailySummary', () => runDailySummary({ notifier }));
  // Receipt photos older than a week. Daily rather than weekly so the database
  // never carries more than eight days of them; the hour is a quiet one.
  at('20 3 * * *', 'wipeReceipts', () => runWipeReceipts());
  // Expired replay keys and rate-limit buckets, old driver calls and long
  // resolved flags (jobs/prune.ts says what is kept).
  at('40 3 * * *', 'prune', () => runPrune());
  // backup.sh runs at 02:00 UTC; by 09:00 Beirut a failed night is known and
  // there is a working day to fix it. Off unless BACKUP_WATCH_DIR is set.
  at('0 9 * * *', 'backupWatch', () => runBackupWatch({ notifier }));
}
