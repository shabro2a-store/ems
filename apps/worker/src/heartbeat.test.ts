import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { beat, heartbeatIsFresh, HEARTBEAT_FILE, HEARTBEAT_MAX_AGE_MS } from './heartbeat';

/*
 * #42: the worker's HEALTHCHECK was `node -e "process.exit(0)"` - it passed
 * whatever the worker was doing, hung or unable to reach its database. The
 * worker now proves it is alive by writing a heartbeat after a real query, and
 * the healthcheck reads how old that heartbeat is.
 */
const dir = mkdtempSync(join(tmpdir(), 'ems-hb-'));
const file = join(dir, 'heartbeat');
afterEach(() => {
  if (existsSync(file)) rmSync(file);
});

describe('the worker heartbeat', () => {
  it('is written after the database answers', async () => {
    const now = new Date('2026-09-28T10:00:00Z');
    await beat({ $queryRaw: async () => [{ '?column?': 1 }] } as never, file, now);
    expect(readFileSync(file, 'utf8')).toBe(now.toISOString());
  });

  it('is not written when the database does not answer', async () => {
    await expect(beat({ $queryRaw: async () => { throw new Error('password authentication failed'); } } as never, file)).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('counts as healthy only while it is recent', async () => {
    const now = new Date('2026-09-28T10:00:00Z');
    await beat({ $queryRaw: async () => [] } as never, file, now);
    expect(heartbeatIsFresh(file, new Date(now.getTime() + 30_000))).toBe(true);
    expect(heartbeatIsFresh(file, new Date(now.getTime() + HEARTBEAT_MAX_AGE_MS + 1))).toBe(false);
    rmSync(file);
    expect(heartbeatIsFresh(file, now)).toBe(false);
  });

  it('is what the container healthcheck reads', () => {
    const dockerfile = readFileSync(join(__dirname, '..', '..', '..', 'Dockerfile.worker'), 'utf8');
    expect(dockerfile).not.toContain('process.exit(0)');
    expect(dockerfile).toContain(HEARTBEAT_FILE);
  });
});
