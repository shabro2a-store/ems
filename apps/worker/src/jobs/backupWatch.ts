import fs from 'fs';
import path from 'path';
import type { Notifier } from 'notify';

/** backup.sh runs at 02:00 UTC; a day plus two hours of slack before a missed night counts. */
export const BACKUP_MAX_AGE_H = 26;

export interface BackupWatchOpts {
  /** The folder backup.sh writes last-success into, mounted read-only. Unset: the watch is off. */
  dir?: string;
  now?: Date;
  notifier: Notifier;
}

export interface BackupWatchResult {
  checked: boolean;
  alerted: boolean;
}

function readLastSuccess(dir: string): Date | null {
  try {
    const at = Date.parse(fs.readFileSync(path.join(dir, 'last-success'), 'utf8').trim());
    return Number.isFinite(at) ? new Date(at) : null;
  } catch {
    return null;
  }
}

/**
 * Tells the owner when the nightly backup has not succeeded for more than a
 * day. backup.sh writes last-success only after a dump that restored and
 * uploaded, so a stale or missing file is a failed night, whatever the log says.
 */
export async function runBackupWatch(opts: BackupWatchOpts): Promise<BackupWatchResult> {
  const dir = opts.dir ?? process.env.BACKUP_WATCH_DIR ?? '';
  if (!dir) return { checked: false, alerted: false };
  const now = opts.now ?? new Date();

  const last = readLastSuccess(dir);
  if (last && now.getTime() - last.getTime() <= BACKUP_MAX_AGE_H * 3_600_000) {
    return { checked: true, alerted: false };
  }

  const detail = last
    ? `Last good backup: ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC (${Math.floor((now.getTime() - last.getTime()) / 3_600_000)} hours ago).`
    : 'No successful backup on record.';
  await opts.notifier.send({
    channel: 'telegram',
    recipient: 'admin',
    template: 'backup.stale',
    context: {
      last_success: last?.toISOString() ?? null,
      message: `${detail} Check /var/log/ems-backup.log on the server.`,
    },
  });
  console.warn(`[backupWatch] ${detail}`);
  return { checked: true, alerted: true };
}
