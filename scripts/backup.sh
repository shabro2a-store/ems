#!/usr/bin/env bash
set -euo pipefail

# Shabro2a EMS - nightly encrypted backup of the database.
#
#   1. pg_dump runs INSIDE the db container, so the host needs no Postgres
#      client of the right version, no DATABASE_URL and no password.
#   2. The dump is encrypted with the passphrase in BACKUP_KEY_FILE. It lives
#      in /etc/ems, not /run/secrets: /run is wiped on every reboot, and a
#      backup nobody can decrypt is not a backup.
#   3. restore.sh --check restores it into a scratch database and counts the
#      rows. A dump that does not restore is deleted and the run fails.
#   4. Local copies older than KEEP_DAYS are deleted.
#   5. rclone uploads it, then deletes remote copies older than KEEP_DAYS, so
#      Drive neither fills up nor keeps receipt photos forever.
#   6. On success, writes the time to $LOCAL_DIR/last-success.
#
# Every failure - the upload included - exits non-zero and says so in the log.
#
# Settings (all optional):
#   BACKUP_KEY_FILE   passphrase file          (default /etc/ems/backup.key)
#   BACKUP_LOCAL_DIR  where encrypted dumps go (default /var/backups/ems)
#   KEEP_DAYS         local and remote         (default 30)
#   RCLONE_REMOTE     upload target            (default gdrive:EMS-Backups;
#                     "none" keeps backups on this machine only, on purpose)
#   EMS_DIR           the compose project      (default: the folder above scripts/)
#
# Cron, as root (docker needs it):
#   0 2 * * * /opt/ems/scripts/backup.sh >> /var/log/ems-backup.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMS_DIR="${EMS_DIR:-$(dirname "$SCRIPT_DIR")}"
KEY_FILE="${BACKUP_KEY_FILE:-${BACKUP_GPG_PASSPHRASE_PATH:-/etc/ems/backup.key}}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/ems}"
KEEP_DAYS="${KEEP_DAYS:-30}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:EMS-Backups}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "BACKUP FAILED: $*"; exit 1; }

[ -r "$KEY_FILE" ] || fail "passphrase file not readable: $KEY_FILE (see RUNBOOK section 3)"
[ -s "$KEY_FILE" ] || fail "passphrase file is empty: $KEY_FILE"
command -v gpg >/dev/null || fail "gpg is not installed"
cd "$EMS_DIR" || fail "no compose project at $EMS_DIR"

umask 077
mkdir -p "$LOCAL_DIR"
ENCRYPTED="${LOCAL_DIR}/ems-$(date -u +%F).dump.gpg"
DUMP="$(mktemp "${TMPDIR:-/tmp}/ems-backup-XXXXXX")"
trap 'shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"' EXIT

log "pg_dump (inside the db container)"
# Written to a file inside the container and then copied out, not piped: a
# custom-format archive written to a pipe has no data offsets, and pg_restore
# can then refuse to restore it.
docker compose exec -T db sh -c '
  pg_dump -U ems -d ems -Fc --no-owner --no-privileges -f /tmp/ems-backup.dump && cat /tmp/ems-backup.dump
  rc=$?; rm -f /tmp/ems-backup.dump; exit $rc' > "$DUMP" || fail "pg_dump failed"
[ -s "$DUMP" ] || fail "pg_dump produced an empty file"

log "encrypt -> $ENCRYPTED"
gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
  --passphrase-file "$KEY_FILE" --output "$ENCRYPTED" "$DUMP" || fail "gpg encrypt failed"

log "restore check"
if ! BACKUP_KEY_FILE="$KEY_FILE" EMS_DIR="$EMS_DIR" "$SCRIPT_DIR/restore.sh" --check "$ENCRYPTED"; then
  rm -f "$ENCRYPTED"
  fail "the new dump did not restore; deleted it"
fi

log "prune local copies older than ${KEEP_DAYS} days"
find "$LOCAL_DIR" -maxdepth 1 -name 'ems-*.dump.gpg' -mtime "+${KEEP_DAYS}" -print -delete

if [ "$RCLONE_REMOTE" = "none" ]; then
  log "RCLONE_REMOTE=none: this backup stays on this machine only"
else
  command -v rclone >/dev/null || fail "rclone is not installed (or set RCLONE_REMOTE=none on purpose)"
  log "upload -> $RCLONE_REMOTE"
  rclone copy "$LOCAL_DIR" "$RCLONE_REMOTE" --include 'ems-*.dump.gpg' || fail "upload to $RCLONE_REMOTE failed"
  log "prune remote copies older than ${KEEP_DAYS} days"
  rclone delete "$RCLONE_REMOTE" --include 'ems-*.dump.gpg' --min-age "${KEEP_DAYS}d" \
    || fail "pruning $RCLONE_REMOTE failed"
fi

date -u +%FT%TZ > "$LOCAL_DIR/last-success"
log "backup complete: $ENCRYPTED"
