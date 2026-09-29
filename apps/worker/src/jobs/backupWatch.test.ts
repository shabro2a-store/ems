import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NotificationPayload, Notifier } from 'notify';
import { runBackupWatch, BACKUP_MAX_AGE_H } from './backupWatch';

/*
 * backup.sh writes last-success after a dump that restored and uploaded. A
 * night that failed only said so in /var/log/ems-backup.log, which nobody reads
 * until they need the backup. The worker reads the file each morning and tells
 * the owner when it is missing or more than a day old.
 */
const now = new Date('2026-09-29T06:00:00Z'); // 09:00 Beirut

function notifier() {
  const sent: NotificationPayload[] = [];
  const n: Notifier = { send: async (p) => void sent.push(p) };
  return { n, sent };
}

describe('runBackupWatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-backup-watch-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stays quiet after last night\'s backup', async () => {
    fs.writeFileSync(path.join(dir, 'last-success'), '2026-09-29T02:04:11Z\n');
    const { n, sent } = notifier();
    expect(await runBackupWatch({ dir, now, notifier: n })).toEqual({ checked: true, alerted: false });
    expect(sent).toEqual([]);
  });

  it('alerts when the last good backup is more than a day old', async () => {
    expect(BACKUP_MAX_AGE_H).toBe(26);
    fs.writeFileSync(path.join(dir, 'last-success'), '2026-09-28T02:04:11Z\n');
    const { n, sent } = notifier();
    expect(await runBackupWatch({ dir, now, notifier: n })).toEqual({ checked: true, alerted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'telegram', recipient: 'admin', template: 'backup.stale' });
    expect(String(sent[0]!.context.message)).toContain('2026-09-28 02:04 UTC (27 hours ago)');
  });

  it('alerts when there has never been a backup', async () => {
    const { n, sent } = notifier();
    expect(await runBackupWatch({ dir, now, notifier: n })).toEqual({ checked: true, alerted: true });
    expect(String(sent[0]!.context.message)).toContain('No successful backup on record');
  });

  it('does nothing when no backup folder is configured', async () => {
    const { n, sent } = notifier();
    expect(await runBackupWatch({ dir: '', now, notifier: n })).toEqual({ checked: false, alerted: false });
    expect(sent).toEqual([]);
  });
});
