#!/usr/bin/env bash
set -euo pipefail

# Shabro2a EMS - restore an encrypted backup.
#
#   restore.sh --check <file.dump.gpg>
#       Restores into a scratch database, counts the rows, drops it. Touches
#       nothing live. backup.sh runs this on every new backup.
#
#   restore.sh <file.dump.gpg>
#       Says what a real restore would do, and stops.
#
#   restore.sh <file.dump.gpg> --force
#       Replaces the live database with the backup:
#         1. checks the file restores (as --check) before touching anything
#         2. stops web and worker, so nobody punches into a database mid-swap
#         3. saves an encrypted copy of the database as it is now
#         4. drops the live database and restores the backup into a new one
#         5. runs the migrations, so an older backup comes up to today's schema
#         6. starts web and worker
#       If 3 fails, nothing has changed and web and worker are started again.
#       To undo a restore, restore the step-3 copy the same way.
#
# Settings: BACKUP_KEY_FILE, BACKUP_LOCAL_DIR and EMS_DIR, as in backup.sh.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMS_DIR="${EMS_DIR:-$(dirname "$SCRIPT_DIR")}"
KEY_FILE="${BACKUP_KEY_FILE:-${BACKUP_GPG_PASSPHRASE_PATH:-/etc/ems/backup.key}}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/ems}"
CHECK_DB="ems_restore_check"

usage() {
  echo "usage: $0 --check <file.dump.gpg>" >&2
  echo "       $0 <file.dump.gpg> [--force]" >&2
  exit 2
}
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "RESTORE FAILED: $*"; exit 1; }

MODE="plan"
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --force) MODE="live"; shift ;;
    -*) usage ;;
    *) [ -z "$FILE" ] || usage; FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || usage
[ -r "$FILE" ] || die "backup not readable: $FILE"
[ -r "$KEY_FILE" ] || die "passphrase file not readable: $KEY_FILE"
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
cd "$EMS_DIR" || die "no compose project at $EMS_DIR"

umask 077
DUMP="$(mktemp "${TMPDIR:-/tmp}/ems-restore-XXXXXX")"
cleanup() {
  shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"
  docker compose exec -T db rm -f /tmp/ems-restore.dump >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_db() { docker compose exec -T db psql -U ems -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"; }
has_service() { docker compose config --services | grep -qx "$1"; }

# Decrypt on the host, then hand the file to the container: pg_restore needs a
# seekable file, and the database's own pg_restore always matches its version.
decrypt_into_container() {
  gpg --batch --yes --quiet --pinentry-mode loopback --decrypt \
    --passphrase-file "$KEY_FILE" --output "$DUMP" "$FILE" || die "could not decrypt $FILE (wrong passphrase?)"
  docker compose exec -T db sh -c 'cat > /tmp/ems-restore.dump' < "$DUMP" || die "could not copy the dump into the db container"
}

restore_into() {
  docker compose exec -T db pg_restore -U ems -d "$1" --no-owner --no-privileges --exit-on-error \
    /tmp/ems-restore.dump || die "pg_restore into $1 failed"
}

check() {
  log "check: restoring $(basename "$FILE") into scratch database $CHECK_DB"
  decrypt_into_container
  docker compose exec -T -e PGOPTIONS=--client-min-messages=warning db dropdb -U ems --if-exists --force "$CHECK_DB"
  docker compose exec -T db createdb -U ems "$CHECK_DB" || die "could not create $CHECK_DB"
  restore_into "$CHECK_DB"
  local users migrations punches last
  users="$(psql_db "$CHECK_DB" 'SELECT count(*) FROM "User"')" || die "restored copy has no User table"
  migrations="$(psql_db "$CHECK_DB" 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')" \
    || die "restored copy has no migration history"
  punches="$(psql_db "$CHECK_DB" 'SELECT count(*) FROM "Punch"')"
  last="$(psql_db "$CHECK_DB" 'SELECT coalesce(max(at)::text, '"'"'none'"'"') FROM "Punch"')"
  docker compose exec -T -e PGOPTIONS=--client-min-messages=warning db dropdb -U ems --if-exists --force "$CHECK_DB"
  [ "$users" -gt 0 ] || die "restored copy has no users"
  [ "$migrations" -gt 0 ] || die "restored copy has no applied migrations"
  log "check passed: $users users, $punches punches (latest $last), $migrations migrations"
}

if [ "$MODE" = "check" ]; then
  check
  exit 0
fi

if [ "$MODE" = "plan" ]; then
  echo "This would REPLACE the live database with $(basename "$FILE"):"
  echo "  stop web and worker, save the current database to $LOCAL_DIR/ems-pre-restore-<time>.dump.gpg,"
  echo "  drop it, restore the backup, run migrations, start web and worker."
  echo "Everything punched since that backup was taken is lost. To do it:"
  echo "  $0 $FILE --force"
  echo "To only prove the file restores, touching nothing:"
  echo "  $0 --check $FILE"
  exit 1
fi

check

log "stopping web and worker"
running=""
for s in web worker; do has_service "$s" && running="$running $s"; done
[ -z "$running" ] || docker compose stop $running

SAFETY="${LOCAL_DIR}/ems-pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
log "saving the current database -> $SAFETY"
mkdir -p "$LOCAL_DIR"
if ! docker compose exec -T db sh -c '
       pg_dump -U ems -d ems -Fc --no-owner --no-privileges -f /tmp/ems-pre-restore.dump && cat /tmp/ems-pre-restore.dump
       rc=$?; rm -f /tmp/ems-pre-restore.dump; exit $rc' \
     | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
         --passphrase-file "$KEY_FILE" --output "$SAFETY"; then
  rm -f "$SAFETY"
  [ -z "$running" ] || docker compose start $running
  die "could not save the current database; nothing was changed"
fi

log "replacing the live database"
decrypt_into_container
docker compose exec -T db dropdb -U ems --force ems || die "could not drop the live database (web and worker are stopped; the copy is $SAFETY)"
docker compose exec -T db createdb -U ems ems || die "could not recreate the live database (restore $SAFETY with --force)"
restore_into ems

if has_service web; then
  log "running migrations"
  docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy \
    || die "migrations failed (web and worker are stopped; the previous database is $SAFETY)"
fi

[ -z "$running" ] || { log "starting$running"; docker compose start $running; }
log "restore complete. The database as it was before is $SAFETY"
