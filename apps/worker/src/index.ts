import cron from 'node-cron';
import { notifier } from 'notify';
import { runWatchedDetector } from './jobs/watchedDetector';
import { runMissedCheckout } from './jobs/missedCheckout';
import { runTripThreshold } from './jobs/tripThreshold';
import { runDriverStale } from './jobs/driverStale';
import { runEndOfDayWatcher } from './jobs/endOfDayWatcher';

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

cron.schedule('*/1 * * * *', safe('watchedDetector', () => runWatchedDetector()));
cron.schedule('*/1 * * * *', safe('missedCheckout', () => runMissedCheckout({ notifier })));
cron.schedule('*/1 * * * *', safe('tripThreshold', () => runTripThreshold({ notifier })));
cron.schedule('*/30 * * * *', safe('driverStale', () => runDriverStale({ notifier })));
cron.schedule('30 23 * * *', safe('endOfDayWatcher', () => runEndOfDayWatcher({ notifier })));

console.log('cron schedule registered:');
console.log('  */1     watchedDetector, missedCheckout, tripThreshold');
console.log('  */30    driverStale');
console.log('  30 23   endOfDayWatcher');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});