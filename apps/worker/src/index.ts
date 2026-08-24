import cron from 'node-cron';
import { getNotifier } from 'notify';
import { runWatchedDetector } from './jobs/watchedDetector';
import { runMissedCheckout } from './jobs/missedCheckout';
import { runAutoCloseAbandoned } from './jobs/autoCloseAbandoned';
import { runAutoCloseAbandonedTrips } from './jobs/autoCloseAbandonedTrips';
import { runTripThreshold } from './jobs/tripThreshold';
import { runDriverStale } from './jobs/driverStale';
import { runEndOfDayWatcher } from './jobs/endOfDayWatcher';
import { runDailySummary } from './jobs/dailySummary';
import { runRingRepeater } from './jobs/ringRepeater';

const notifier = getNotifier();

console.log('cron runner started');

function safe(name: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[cron:${name}]`, e);
    }
  };
}

// Six fields: this one runs every five SECONDS. A ring has to behave like a
// phone ringing rather than a single notification nobody heard, and the driver
// is standing in a shop waiting - a one-minute tick is not a ring, it is a
// reminder. The query is one indexed read over a table that is empty except in
// the forty-five seconds after somebody is called.
cron.schedule('*/5 * * * * *', safe('ringRepeater', () => runRingRepeater()));
cron.schedule('10 0 * * *', safe('watchedDetector', () => runWatchedDetector()));
cron.schedule('*/1 * * * *', safe('missedCheckout', () => runMissedCheckout({ notifier })));
cron.schedule('*/1 * * * *', safe('tripThreshold', () => runTripThreshold({ notifier })));
// Every 10 min is plenty for a 30h threshold, and keeps a job that writes
// punches off the same minute tick as the read-only alerting jobs.
cron.schedule('*/10 * * * *', safe('autoCloseAbandoned', () => runAutoCloseAbandoned()));
// Same tick, same reason: a trip nobody closed blocks the driver's punches and
// their dispatch, and a driver who never comes back cannot clear it themselves.
cron.schedule('*/10 * * * *', safe('autoCloseAbandonedTrips', () => runAutoCloseAbandonedTrips()));
cron.schedule('*/30 * * * *', safe('driverStale', () => runDriverStale({ notifier })));
cron.schedule('30 23 * * *', safe('endOfDayWatcher', () => runEndOfDayWatcher({ notifier })));
cron.schedule('0 23 * * *', safe('dailySummary', () => runDailySummary({ notifier })));

console.log('cron schedule registered:');
console.log('  */5s    ringRepeater');
console.log('  10 0    watchedDetector');
console.log('  */1     missedCheckout, tripThreshold');
console.log('  */10    autoCloseAbandoned, autoCloseAbandonedTrips');
console.log('  */30    driverStale');
console.log('  30 23   endOfDayWatcher');
console.log('  0 23    dailySummary');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});