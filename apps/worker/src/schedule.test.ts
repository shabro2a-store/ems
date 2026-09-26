import { describe, it, expect } from 'vitest';
import type { Notifier } from 'notify';
import { registerJobs, type CronLike } from './schedule';

/*
 * The container's clock is UTC. A cron line with no zone fires on that clock,
 * so "0 23" sent the daily summary at 02:00 Beirut in summer - by which time
 * "today" was the day that had just begun, and everyone read as absent.
 */
function registered() {
  const jobs: Array<{ expression: string; timezone?: string }> = [];
  const cron: CronLike = {
    schedule: (expression, _fn, options) => jobs.push({ expression, timezone: options?.timezone }),
  };
  const notifier: Notifier = { send: async () => undefined } as unknown as Notifier;
  registerJobs(cron, notifier);
  return jobs;
}

describe('the worker schedule', () => {
  it('reads every cron line on the shop clock', () => {
    const jobs = registered();
    expect(jobs.length).toBe(10);
    for (const j of jobs) expect(j.timezone, j.expression).toBe('Asia/Beirut');
  });

  it('sends the day summary and the end-of-day check before the day ends', () => {
    const expressions = registered().map((j) => j.expression);
    expect(expressions).toContain('0 23 * * *');
    expect(expressions).toContain('30 23 * * *');
  });
});
