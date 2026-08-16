# RUNBOOK — Shabro2a EMS

Operational procedures for local dev, production deploy, and on-call response.

Production is a VPS running Docker Compose behind a Cloudflare Tunnel
(`https://app.shabro2a.com` → `localhost:3000`). Three containers — `db`
(Postgres 16), `web` (Next.js), `worker` (cron) — all defined in the single
`docker-compose.yml` at the repo root. [DEPLOY.md](DEPLOY.md) is the source of
truth for first-time setup; this file covers running it day to day.

---

## 1. Local dev quickstart

Prereqs: Node 20, pnpm 9, Docker (for the Postgres dev DB).

```bash
git clone <repo>
cd <repo>
cp .env.example .env                          # POSTGRES_PASSWORD is required; compose won't start without it
docker compose up -d db                       # Postgres on 127.0.0.1:5433 (host only)
pnpm install
pnpm --filter db exec prisma generate
pnpm --filter db exec prisma migrate deploy   # or `prisma migrate dev` on a fresh DB
pnpm --filter db db:seed
```

The web and worker processes need these in the environment:

```bash
DATABASE_URL=postgresql://ems:ems_dev_password@localhost:5433/ems
JWT_SECRET=<any 32+ char string for local>
ENABLE_DEV_ENDPOINTS=true    # shows the Dev IN/OUT GPS bypass (laptops have no GPS)
```

Then:

```bash
pnpm --filter web dev      # http://localhost:3000
pnpm --filter worker dev   # cron runner in foreground (Ctrl+C to stop)
```

Seed credentials (development only — never in prod):
- Admin: `owner` / `change-me`
- Sample employee/driver per branch: see `packages/db/prisma/seed.ts`

Run checks:
```bash
pnpm -r typecheck                 # typecheck entire monorepo
pnpm -r test                      # unit + HTTP integration tests
```
The integration tests hit a live server at `TEST_BASE_URL`
(default `http://127.0.0.1:3000`) and need a reachable Postgres.

**The server itself needs `DATABASE_URL` and `JWT_SECRET` in its own process to
boot** — a root `.env` (matching `.env.example`) is the project's convention, and
test-helper code loads it automatically, but `next dev`/`next build`/`next start`
run with their cwd inside `apps/web` (that is where `pnpm --filter web ...`
executes the script), and Next's own `.env` loader only checks that directory. A
root `.env` sitting there is silently ignored by the running server. Export the
variables into the shell that starts the server, e.g. from the repo root:
```bash
set -a; source .env; set +a
pnpm --filter web dev   # or build && start, for the integration-test flow
```
or copy `.env` into `apps/web/.env` so Next picks it up itself. Skip this and the
HTTP integration suite fails across most of its files with a misleading `login
failed: 500` — the real cause, visible only in the server's own log output, is
`JWT_SECRET missing or too short`.

To run only the standalone unit tests:
```bash
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts"
```

---

## 2. Production deploy

Full first-time setup (env file, VAPID keys, Telegram, Cloudflare) lives in
[DEPLOY.md](DEPLOY.md). The routine redeploy, on the VPS:

```bash
cd /opt/ems
git pull                                      # branch: master
docker compose build
docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy
docker compose up -d
```

Build first, migrate second, swap last. `migrate deploy` is a no-op when the pull
added no migration, so this order is always safe — **for this release specifically
it is required, not just good practice.** The migration drops the old schedule
`start_time`/`end_time` columns and retires the `LATE`, `EARLY_LEAVE` and
`TIME_CHANGE` enum values; the new image's Prisma client no longer recognises
those values at all. If the new containers serve traffic before `prisma migrate
deploy` runs, every read touching a `PenaltyWaiver`, `PenaltyAck`,
`ScheduleOverride` or `LeaveRequest` row still carrying a retired value throws a
Prisma enum-deserialisation error, and it keeps failing until the migration runs —
do not run `docker compose up -d` ahead of the migrate step above. The same
migration also permanently deletes every `PenaltyWaiver`/`PenaltyAck` row
referencing the retired kinds; take a backup first (§3 below) if you want the
option to go back. See [DEPLOY.md](DEPLOY.md) for the full explanation.

Verify the swap actually happened — `uptime_s` should be near zero:

```bash
docker compose ps
curl -s http://localhost:3000/api/health
```

If `uptime_s` is large, the containers were never replaced (usually a build that
failed earlier in the chain).

**Environment lives in `/opt/ems/.env`**, which `docker-compose.yml` reads via
`${VAR}` substitution. The stack refuses to start without `JWT_SECRET`. See
`.env.example` for the full list. Note that adding a variable to `.env` is not
enough on its own — it must also be listed under the service's `environment:`
block in `docker-compose.yml`, or the container never sees it.

---

## 3. Backup setup

Run once on the VPS after first deploy:

1. **Generate GPG passphrase file** (mode 0400, owned by backup user):
   ```bash
   sudo install -d -m 0700 -o backup -g backup /run/secrets
   openssl rand -hex 32 | sudo tee /run/secrets/backup.key | sudo chmod 0400 /run/secrets/backup.key
   sudo chown backup:backup /run/secrets/backup.key
   ```

2. **Configure rclone** for Google Drive:
   ```bash
   sudo -u backup rclone config
   # name: gdrive
   # type: drive
   # follow the wizard; the resulting config lives at /root/.config/rclone/rclone.conf
   # copy to /root/.config/rclone/rclone.conf (or the backup user's home)
   ```

3. **Test backup manually**:
   ```bash
   sudo -u backup BACKUP_GPG_PASSPHRASE_PATH=/run/secrets/backup.key \
     /opt/ems/scripts/backup.sh
   # verify /var/backups/ems/ems-YYYY-MM-DD.dump.gpg exists
   ```

4. **Schedule the cron**:
   ```cron
   0 2 * * * backup /opt/ems/scripts/backup.sh >> /var/log/ems-backup.log 2>&1
   ```

---

## 4. Restore procedure

**Always dry-run first.**

1. **List available dumps**:
   ```bash
   ls -lh /var/backups/ems/        # local
   rclone ls gdrive:EMS-Backups/   # remote
   ```

2. **Restore into a staging DB** (never prod first time):
   ```bash
   # create empty staging DB
   createdb -h <staging-host> -U ems ems_restore_test
   DATABASE_URL=postgresql://ems:<pw>@<staging-host>:5432/ems_restore_test \
     /opt/ems/scripts/restore.sh /var/backups/ems/ems-2026-07-19.dump.gpg
   ```

3. **Spot-check** the restored data:
   ```bash
   psql $RESTORE_URL -c "SELECT COUNT(*) FROM \"User\";"
   psql $RESTORE_URL -c "SELECT MAX(at) FROM \"Punch\";"
   ```

4. **Restore into prod** (only after spot-check passes):
   ```bash
   # BACKUP the current state first
   /opt/ems/scripts/backup.sh
   # then restore
   DATABASE_URL=$PROD_URL /opt/ems/scripts/restore.sh /var/backups/ems/ems-2026-07-19.dump.gpg
   ```

**Point-in-time caveat:** `pg_restore` only restores the state at dump-time. There is no WAL archiving, so any punches recorded after the dump are lost. For real PITR, enable `archive_mode=on` + `archive_command` on the DB and stream WALs to S3.

---

## 5. Common ops

### Add a new branch
1. Owner adds via `https://app.shabro2a.com/admin/branches` → **＋ Add branch**,
   name it. Radius, max GPS accuracy, overtime grace and trip threshold all start
   at defaults (50m / 100m / 15 min / 30 min) — open **Edit** right after to change
   any of them for this branch.
2. **Record the GPS on-site.** A new branch defaults to 0,0 and nobody can punch
   until its location is recorded: on a phone, standing at the branch, open
   Branches → the branch → **📍 Record location**.
3. **Overtime grace** and **trip threshold** both change behaviour rather than
   geofencing. Overtime grace sets how far past an employee's required hours a day
   has to run before it is reported to the owner — it does not shrink or forgive the
   reported overrun, only whether small ones get reported at all. Trip threshold sets
   when an open trip is flagged `over_threshold` and alerted (`tripThreshold` job).
   Radius and max GPS accuracy are the geofencing fields — they decide whether a punch
   or trip is accepted at all, not what gets reported afterward.
4. Payroll is unaffected — payout uses branches only for filtering.

### Rotate `JWT_SECRET`
- **All users get logged out.** Edit `/opt/ems/.env`, then `docker compose up -d`
  to recreate the containers with the new value.
- No data loss; cookies become invalid and users re-login.
- Also invalidates any outstanding Telegram bind codes (existing bindings survive).

### Deploy a hotfix
- Push to `master`, then run the section 2 redeploy on the VPS. There is no
  auto-deploy webhook — deploys are manual.
- Hotfixes that don't touch `schema.prisma` still run `migrate deploy` harmlessly.

### Pause / resume the worker
- `docker compose stop worker` — cron jobs halt; no missed-checkout detection,
  trip-threshold alerts, or daily summary run.
- Restart with `docker compose start worker`.
- The owner dashboard stays available; only cron-side alerts pause.

### Check what the containers actually received
Env vars must be listed in `docker-compose.yml`, not just present in `.env`:
```bash
docker compose exec web env | grep -E 'VAPID|TELEGRAM|SENTRY|ENABLE_DEV'
```

---

## 6. Common alerts and what they mean

| Alert | Likely cause | First action |
|---|---|---|
| `GET /api/health` 3xx/5xx | Container crashed, or OOMKilled | `docker compose logs web`; check memory limit |
| `GET /api/health/db` 503 | Postgres down or slow (>50ms) | `docker compose logs db`; check disk; check connection pool |
| Backup didn't run (no new file in `/var/backups/ems/`) | Cron misconfigured, or rclone auth expired | Run `backup.sh` manually; rotate rclone token |
| Telegram webhook 4xx spike | Bot token rotated but `TELEGRAM_BOT_TOKEN` env not refreshed | Update `/opt/ems/.env`, `docker compose up -d` |
| Telegram webhook 5xx spike | Network issue to api.telegram.org | Check VPS outbound; usually self-resolves |
| Sentry alert: spike of `UNAUTHORIZED` | `JWT_SECRET` rotated (expected) or cookie domain misconfigured | Check most recent deploy; correlate with `JWT_SECRET` changes |
| Sentry alert: spike of `INVALID_INPUT` | Schema drift between client + server | Verify both are on the latest `master` |
| Drivers stop receiving the ring on locked phones | `VAPID_*` keys missing from the container, or rolled | `docker compose exec web env \| grep VAPID`; if rolled, each driver re-taps **Enable** |
| `/admin/punches` empty | Genuine fault — this page is backed by `/api/admin/punches` and should show history | Check `docker compose logs web` for the API error; verify the branch/date filters aren't excluding everything |

**A single `DB_SLOW` right after a deploy or restart?** The connection pool is cold
on the first query of a new process — one observed run measured 134ms against the
50ms limit, then 1-12ms on every call right after. This is separate from the
`/api/health` check the production checklist asks for (that one only reports
uptime, never touches the DB) — if you also check `/api/health/db` right after a
deploy, as is natural, re-run it a few seconds later before treating a `DB_SLOW`
as real. Only one that persists across repeated checks is worth chasing as actual
Postgres load or disk trouble.

**No Sentry alerts at all?** Sentry only initialises when both `SENTRY_DSN` is set
*and* `NODE_ENV=production`. Confirm with
`docker compose exec web env | grep SENTRY_DSN`.

---

## 7. Escalation

Single-owner shop: the owner is the escalation path and is reachable directly,
with a branch manager as backup. No on-call rota to maintain here.
