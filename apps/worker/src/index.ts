import cron from 'node-cron';
import { getNotifier } from 'notify';
import { registerJobs } from './schedule';

console.log('cron runner started');

registerJobs(cron, getNotifier());

console.log('cron schedule registered (Asia/Beirut):');
console.log('  */5s    ringRepeater');
console.log('  10 *    watchedDetector');
console.log('  */1     missedCheckout, tripThreshold');
console.log('  */10    autoCloseAbandoned, autoCloseAbandonedTrips');
console.log('  */30    driverStale');
console.log('  30 23   endOfDayWatcher');
console.log('  0 23    dailySummary');
console.log('  20 3    wipeReceipts');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});
