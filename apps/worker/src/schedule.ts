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

/** The part of node-cron this file uses, so the table can be read without starting it. */
export interface CronLike {
  schedule(expression: string, fn: () => unknown, options?: { timezone?: string }): unknown;
}

function safe(name: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[cron:${name}]`, e);
    }
  };
}

export function registerJobs(cron: CronLike, notifier: Notifier): void {
  // Every line is read on the shop's clock. The container's is UTC, so without
  // this "0 23" was 02:00 Beirut in summer and 01:00 in winter, and the evening
  // summary described the day that had just begun.
  const at = (expression: string, name: string, fn: () => Promise<unknown>) =>
    cron.schedule(expression, safe(name, fn), { timezone: SHOP_TZ });

  // Six fields: this one runs every five SECONDS. A ring has to behave like a
  // phone ringing rather than a single notification nobody heard, and the driver
  // is standing in a shop waiting - a one-minute tick is not a ring, it is a
  // reminder. The query is one indexed read over a table that is empty except in
  // the forty-five seconds after somebody is called.
  at('*/5 * * * * *', 'ringRepeater', () => runRingRepeater());
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
}
