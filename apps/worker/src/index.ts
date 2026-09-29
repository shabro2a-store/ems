import * as Sentry from '@sentry/node';
import cron from 'node-cron';
import { getNotifier } from 'notify';
import { registerJobs } from './schedule';

// Unset = off: captureException in guarded() is then a no-op.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0 });
}

console.log('cron runner started');

registerJobs(cron, getNotifier());

console.log('cron schedule registered (Asia/Beirut):');
console.log('  */5s    ringRepeater');
console.log('  */30s   heartbeat (healthcheck)');
console.log('  10 *    watchedDetector');
console.log('  */1     missedCheckout, tripThreshold');
console.log('  */10    autoCloseAbandoned, autoCloseAbandonedTrips');
console.log('  */30    driverStale');
console.log('  30 23   endOfDayWatcher');
console.log('  0 23    dailySummary');
console.log('  20 3    wipeReceipts');
console.log('  40 3    prune');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});
