import cron from 'node-cron';
import { getNotifier } from 'notify';
import { runWatchedDetector } from './jobs/watchedDetector';
import { runMissedCheckout } from './jobs/missedCheckout';
import { runTripThreshold } from './jobs/tripThreshold';
import { runDriverStale } from './jobs/driverStale';
import { runEndOfDayWatcher } from './jobs/endOfDayWatcher';
import { runDailySummary } from './jobs/dailySummary';

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

cron.schedule('10 0 * * *', safe('watchedDetector', () => runWatchedDetector()));
cron.schedule('*/1 * * * *', safe('missedCheckout', () => runMissedCheckout({ notifier })));
cron.schedule('*/1 * * * *', safe('tripThreshold', () => runTripThreshold({ notifier })));
cron.schedule('*/30 * * * *', safe('driverStale', () => runDriverStale({ notifier })));
cron.schedule('30 23 * * *', safe('endOfDayWatcher', () => runEndOfDayWatcher({ notifier })));
cron.schedule('0 23 * * *', safe('dailySummary', () => runDailySummary({ notifier })));

console.log('cron schedule registered:');
console.log('  10 0    watchedDetector');
console.log('  */1     missedCheckout, tripThreshold');
console.log('  */30    driverStale');
console.log('  30 23   endOfDayWatcher');
console.log('  0 23    dailySummary');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});