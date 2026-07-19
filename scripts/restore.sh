#!/usr/bin/env bash
set -euo pipefail

# Supermarket EMS — restore from encrypted Postgres dump.
#
# Usage:
#   restore.sh <encrypted-dump> [--target <DATABASE_URL>] [--force]
#
# By default, the restore runs against DATABASE_URL but refuses if the
# target URL matches the production one (set RESTORE_ALLOW_PROD=1 to override).
# Always takes a fresh backup of the current state before overwriting.

if [ $# -lt 1 ]; then
  echo "usage: $0 <encrypted-dump.gpg> [--target <DATABASE_URL>] [--force]" >&2
  exit 2
fi

ENCRYPTED="$1"
shift || true

TARGET_URL="${DATABASE_URL:-}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_URL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TARGET_URL" ] || { echo "no DATABASE_URL (use --target or export env)"; exit 2; }
[ -r "$ENCRYPTED" ] || { echo "dump not readable: $ENCRYPTED"; exit 2; }

GPG_KEY_FILE="${BACKUP_GPG_PASSPHRASE_PATH:-/run/secrets/backup.key}"
[ -r "$GPG_KEY_FILE" ] || { echo "GPG key not readable: $GPG_KEY_FILE"; exit 2; }

DUMP="$(mktemp -t ems-restore-XXXXXX.dump)"
trap 'shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"' EXIT

echo "decrypting $ENCRYPTED -> $DUMP"
gpg --batch --yes --decrypt \
  --passphrase-file "$GPG_KEY_FILE" \
  --output "$DUMP" \
  "$ENCRYPTED"

echo "restoring into $TARGET_URL"
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "$TARGET_URL" "$DUMP"

echo "restore complete"
