console.log('cron runner started');

process.on('SIGTERM', () => {
  console.log('worker received SIGTERM, shutting down');
  process.exit(0);
});

setInterval(() => {}, 1000 * 60 * 60);