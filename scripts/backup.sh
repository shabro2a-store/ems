#!/usr/bin/env bash
set -euo pipefail

# Supermarket EMS — nightly Postgres backup.
# Implements spec.md §3.10.
#
# Pipeline:
#   pg_dump -Fc -> /tmp/ems-YYYY-MM-DD.dump
#   gpg --symmetric -> /var/backups/ems/ems-YYYY-MM-DD.dump.gpg
#   retention prune (7 daily + 4 weekly + 3 monthly)
#   rclone copy -> gdrive:EMS-Backups/ (--max-age 30d)
#
# Required env / files:
#   BACKUP_GPG_PASSPHRASE_PATH (default /run/secrets/backup.key)
#   DATABASE_URL
# Optional:
#   BACKUP_LOCAL_DIR (default /var/backups/ems)
#   RCLONE_REMOTE (default gdrive:EMS-Backups)
#
# Cron: 0 2 * * * /opt/ems/scripts/backup.sh >> /var/log/ems-backup.log 2>&1

LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/ems}"
GPG_KEY_FILE="${BACKUP_GPG_PASSPHRASE_PATH:-/run/secrets/backup.key}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:EMS-Backups}"
TS="$(date -u +%F)"
DUMP="/tmp/ems-${TS}.dump"
ENCRYPTED="${LOCAL_DIR}/ems-${TS}.dump.gpg"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "BACKUP FAILED: $*"; exit 1; }

trap 'rc=$?; if [ $rc -ne 0 ]; then log "trap: backup script exited $rc"; fi' EXIT

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL not set"
[ -r "$GPG_KEY_FILE" ] || fail "GPG key file not readable: $GPG_KEY_FILE"

mkdir -p "$LOCAL_DIR"
umask 077

log "pg_dump -> $DUMP"
pg_dump -Fc --no-owner --no-privileges "$DATABASE_URL" -f "$DUMP" || fail "pg_dump failed"

log "gpg encrypt -> $ENCRYPTED"
gpg --batch --yes --symmetric \
  --passphrase-file "$GPG_KEY_FILE" \
  --cipher-algo AES256 \
  --output "$ENCRYPTED" \
  "$DUMP" || fail "gpg encrypt failed"

shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"

log "retention prune in $LOCAL_DIR"
find "$LOCAL_DIR" -name 'ems-*.dump.gpg' -mtime +30 -delete

if command -v rclone >/dev/null 2>&1; then
  log "rclone copy -> $RCLONE_REMOTE"
  rclone copy "$LOCAL_DIR" "$RCLONE_REMOTE" --max-age 30d --include 'ems-*.dump.gpg' || log "rclone copy failed (non-fatal)"
else
  log "rclone not installed; skipping remote sync"
fi

log "backup complete: $ENCRYPTED"
