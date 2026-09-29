import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/node', () => ({ captureException: (...a: unknown[]) => captureException(...a), init: vi.fn() }));

import { guarded } from './schedule';

/*
 * A job that threw was written to the container log and nowhere else, so a
 * sweep failing every ten minutes went unseen until somebody read the log.
 * With SENTRY_DSN set, the failure also reaches Sentry, tagged with the job.
 */
describe('a failing scheduled job', () => {
  beforeEach(() => {
    captureException.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('is reported to Sentry with the job name', async () => {
    const err = new Error('boom');
    await guarded('reportedJob', async () => {
      throw err;
    })();
    expect(captureException).toHaveBeenCalledWith(err, { tags: { job: 'reportedJob' } });
  });

  it('reports a job that keeps failing once an hour, not on every tick', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
      const tick = guarded('stuckJob', async () => {
        throw new Error('database down');
      });
      await tick();
      await tick();
      await tick();
      expect(captureException).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-09-29T11:00:01Z'));
      await tick();
      expect(captureException).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports again straight away when a job fails after it had recovered', async () => {
    let fail = true;
    const tick = guarded('flakyJob', async () => {
      if (fail) throw new Error('once');
    });
    await tick();
    fail = false;
    await tick();
    fail = true;
    await tick();
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('reports nothing when the job succeeds', async () => {
    await guarded('quietJob', async () => undefined)();
    expect(captureException).not.toHaveBeenCalled();
  });
});
