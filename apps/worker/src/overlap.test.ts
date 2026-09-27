import { describe, it, expect } from 'vitest';
import { guarded } from './schedule';

/*
 * #40: node-cron starts a job on its tick whether or not the last run has
 * finished, so a slow run (a big sweep, a slow database) overlapped the next
 * one - two sweeps writing the same checkouts, two ring repeaters pushing
 * twice. A tick that finds its job still running now skips.
 */
describe('a scheduled job', () => {
  it('skips a tick while its previous run is still going', async () => {
    let runs = 0;
    let release!: () => void;
    const slow = () =>
      new Promise<void>((resolve) => {
        runs += 1;
        release = resolve;
      });
    const tick = guarded('slowJob', slow);
    const first = tick();
    await tick();
    await tick();
    expect(runs).toBe(1);
    release();
    await first;
    const second = tick();
    expect(runs).toBe(2);
    release();
    await second;
  });

  it('runs again after a run that failed', async () => {
    let runs = 0;
    const failing = guarded('failingJob', async () => {
      runs += 1;
      throw new Error('boom');
    });
    await failing();
    await failing();
    expect(runs).toBe(2);
  });
});
