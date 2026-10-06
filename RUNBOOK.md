# RUNBOOK — Shabro2a EMS

Operational procedures for local dev, production deploy, and on-call response.

Production is a VPS running Docker Compose behind a Cloudflare Tunnel
(`https://app.shabro2a.com` → `localhost:3000`). Three containers — `db`
(Postgres 16), `web` (Next.js), `worker` (cron) — all defined in the single
`docker-compose.yml` at the repo root. [DEPLOY.md](DEPLOY.md) is the source of
truth for first-time setup; this file covers running it day to day.

---

## 1. Local dev quickstart

Prereqs: Node 22 (`.nvmrc`), pnpm 9, Docker (for the Postgres dev DB).

```bash
git clone <repo>
cd <repo>
cp .env.example .env                          # POSTGRES_PASSWORD is required; compose won't start without it
docker compose up -d db                       # Postgres on 127.0.0.1:5433 (host only)
pnpm install
pnpm --filter db exec prisma generate
pnpm --filter db exec prisma migrate deploy   # or `prisma migrate dev` on a fresh DB
pnpm --filter db db:seed                      # empty database only; refuses otherwise
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
- Sample employees `emp1`/`emp2` (one per branch), same password; no driver
- The seed refuses a database that already has users or branches, so it cannot
  be re-run over existing data. For a clean local start: `pnpm --filter db exec prisma migrate reset`

Run checks:
```bash
pnpm -r typecheck                 # typecheck entire monorepo
pnpm -r test                      # unit + HTTP integration tests
```
The integration tests hit a live server at `TEST_BASE_URL`
(default `http://127.0.0.1:3000`) and need a reachable Postgres. They **erase every
table** of the database they use, so they refuse any `DATABASE_URL` whose database name
does not end in `_test` — create `ems_test` for them and run the server under test
against it too (README "Checks"). Never run them on the VPS.

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
grep -q '^APP_DB_PASSWORD=' .env || echo "APP_DB_PASSWORD=$(openssl rand -hex 24)" >> .env   # once; a no-op after
docker compose build
docker compose up -d
```

`up -d` runs the one-shot `migrate` service (`prisma migrate deploy`, a no-op when
nothing is new) and starts `web` and `worker` only after it exits cleanly. The site is
down for the seconds the migration takes. If it fails, `web` and `worker` stay down
until it is fixed: `docker compose logs migrate`. Before a migration that deletes
data, take a backup (§3). See [DEPLOY.md](DEPLOY.md) for the full explanation.

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

`scripts/backup.sh` dumps the database from inside the `db` container, encrypts it,
**restores it into a scratch database to prove it works**, keeps 30 days on the VPS,
uploads to Google Drive and deletes Drive copies older than 30 days. It runs as root,
because it drives `docker compose`. **Receipt photos are not backed up** (the owner's
call): the app deletes them after 7 days anyway, and they were most of every dump. A
restore brings back every trip with its `receipt_taken_at`; only the photos of the
last week are missing.

It reads `/opt/ems/.env` through `docker compose`, so that file must already have
`POSTGRES_PASSWORD`, `JWT_SECRET` and `APP_DB_PASSWORD`. On a server still running
code from before 2026-09-26, do steps 1-3 **after** `git pull` and the two `.env`
lines of the redeploy (section 2), **before** `docker compose build` - the first backup
is then the database exactly as it was before that deploy's migrations.

Run once on the VPS:

1. **The passphrase.** It lives in `/etc/ems`, which survives a reboot — `/run/secrets`
   (the old location) is wiped by every reboot, taking the only key with it.
   ```bash
   sudo install -d -m 0700 /etc/ems
   # already have one in /run/secrets? keep it, or every existing backup is lost:
   sudo cp /run/secrets/backup.key /etc/ems/backup.key 2>/dev/null \
     || openssl rand -hex 32 | sudo tee /etc/ems/backup.key >/dev/null
   sudo chmod 0400 /etc/ems/backup.key
   sudo cat /etc/ems/backup.key
   ```
   **Copy that line into your password manager now.** If the VPS dies, the backups on
   Drive can only be opened with it.

2. **Google Drive** (as root, so the cron job finds the config):
   ```bash
   sudo apt-get install -y rclone gnupg
   sudo rclone config
   ```
   In the wizard: `n` (new remote), name **`gdrive`**, storage **`drive`**, leave
   client id and secret empty, scope **`drive.file`** (rclone sees only the files it
   made, not the rest of the Drive), leave the rest at the defaults. The VPS has no
   browser, so answer **`n`** to "Use web browser to automatically authenticate". It
   prints a command like `rclone authorize "drive" "..."`: run that on your own
   computer (Windows: `winget install Rclone.Rclone`, in a new terminal), sign in to
   the Google account the backups should go to, and paste the token it prints back
   into the VPS. Check it:
   ```bash
   sudo rclone lsd gdrive:        # lists folders, no error
   ```
   No Drive? Put `RCLONE_REMOTE=none` in front of the command in the cron line, and
   backups stay on the VPS only — which does not survive losing the VPS.

3. **Run it once by hand** and read the end of the output:
   ```bash
   sudo /opt/ems/scripts/backup.sh
   # expect: "check passed: N users, N punches ..." then "backup complete"
   sudo rclone ls gdrive:EMS-Backups   # the new ems-<date>.dump.gpg is there
   ```

4. **Schedule it** (`sudo crontab -e`):
   ```cron
   0 2 * * * /opt/ems/scripts/backup.sh >> /var/log/ems-backup.log 2>&1
   ```

5. **Turn on the morning check.** Add `BACKUP_WATCH_DIR=/backups` to `/opt/ems/.env`
   and run `docker compose up -d`. The worker reads `last-success` (the folder is
   mounted into it read-only) at 09:00 Beirut and sends **Backup missing** on
   Telegram when it is absent or more than 26 hours old. By hand:
   ```bash
   cat /var/backups/ems/last-success           # should be today, around 02:00 UTC
   grep 'BACKUP FAILED' /var/log/ems-backup.log | tail
   ```

---

## 4. Restore procedure

1. **Pick a backup**:
   ```bash
   ls -lh /var/backups/ems/                                                        # on the VPS
   sudo rclone copy gdrive:EMS-Backups/ems-2026-07-19.dump.gpg /var/backups/ems/   # or from Drive
   ```

2. **Prove it restores** — into a scratch database, touching nothing live:
   ```bash
   sudo /opt/ems/scripts/restore.sh --check /var/backups/ems/ems-2026-07-19.dump.gpg
   # "check passed: N users, N punches (latest ...)" - the latest punch says how old it is
   ```

3. **Restore it for real**:
   ```bash
   sudo /opt/ems/scripts/restore.sh /var/backups/ems/ems-2026-07-19.dump.gpg --force
   ```
   It checks the file again, stops `web` and `worker`, saves the database as it is now
   to `/var/backups/ems/ems-pre-restore-<time>.dump.gpg`, replaces it with the backup,
   runs the migrations and starts `web` and `worker`. Without `--force` it only says what
   it would do. **To undo**, restore the `ems-pre-restore-…` file the same way.

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
- Does not touch Telegram. Binding is a stored chat id, not a derived secret.

### Deploy a hotfix
- Push to `master`, then run the section 2 redeploy on the VPS. There is no
  auto-deploy webhook — deploys are manual.
- The `migrate` service runs on every `up -d`; with no new migration it does nothing.

### Updating the base images
The Dockerfiles, `docker-compose.yml` and CI pin `node:22-alpine` and
`postgres:16-alpine` to exact digests, so a rebuild never picks up a different base
without anyone noticing. To take upstream security fixes (every month or two):
```bash
docker pull node:22-alpine && docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}'
docker pull postgres:16-alpine && docker image inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'
```
Paste each new `sha256:...` into `Dockerfile.web` (both `FROM` lines),
`Dockerfile.worker`, `docker-compose.yml` (`db`) and `.github/workflows/ci.yml`
(both Postgres services), let CI pass, then redeploy. Postgres stays on 16: a new
major version needs a dump and restore, not a new tag.

### Pause / resume the worker
- `docker compose stop worker` — cron jobs halt; no missed-checkout detection,
  trip-threshold alerts, or daily summary run.
- Restart with `docker compose start worker`.
- The owner dashboard stays available; only cron-side alerts pause.
- `ringRepeater` also stops, which matters within seconds rather than hours: a
  driver still gets the first push from the ring itself, but it will not repeat,
  so a missed ring stays missed. Restart the worker before a busy service.
- Two of the halted jobs write rather than alert: `autoCloseAbandoned` closes a
  check-in left open past 20h, and `autoCloseAbandonedTrips` closes a delivery
  left open past 6h. Neither is load-bearing for staff — an employee's next
  check-in closes their own stale session, and a driver's next punch closes
  their own stale trip, both without the worker. What only the worker does is
  clear the sessions and trips of people who do not come back at all, so a long
  worker outage shows up as drivers the counter cannot ring and a payroll month
  with open sessions in it. Both jobs are idempotent; they catch up on restart.

### Making the driver ring loud
The most common complaint. There are two completely different cases and they
sound nothing alike, so establish which one you are in before changing anything.

**Case A — the app is running (even backgrounded, screen off, phone in pocket).**
A real looping siren blasts at media volume and does not stop until the driver
presses *Got it — stop*. This is the loud case, and it is the one to aim for.
It works because `DriverAlarm` holds an inaudible keep-alive loop playing from
the first tap of the shift: Android freezes a backgrounded page after a few
minutes, and active media playback is one of the few things that prevents it, so
the page is still alive to blast when the push lands.

**Case B — the app was swiped away, or the phone rebooted.** There is no page,
so nothing can play a sound of its own. A service worker has no audio output and
no API grants it one. All that is left is the push notification, and how loud
*that* is belongs to the Android notification channel — a per-handset setting no
website can reach.

So the goal is to keep drivers in case A, with case B set up as the fallback.

**Per phone, once.** Android:
1. Chrome → ⋮ → **Install app**, and use the home-screen icon from then on.
2. Open it at the start of the shift and **tap the screen once** — the banner
   says *Tap here to arm the siren*. Nothing can make a sound before that tap;
   browsers refuse audio until the user has interacted with the page. Once armed
   it stays armed for as long as the app is running.
3. **Do not swipe the app away.** Leave it in the background. Swiping it closed
   drops the phone into case B.
4. Settings → Apps → the app → **Notifications** → the site's channel:
   - Importance / behaviour: **Urgent**
   - **Sound: pick a ringtone**, not a notification blip — this is what case B
     sounds like
   - Vibration on, and **Override Do Not Disturb** on
5. Settings → Apps → the app → **Battery** → **Unrestricted**, or Android delays
   the pushes and it reads as "it rang late" or "it never rang".
6. Raise **both** volume sliders. The siren plays on **media**; the notification
   plays on **notification**. They are separate on Android — press volume, then
   the ⋮/gear, and raise both.

**How long it rings.** Until the driver stops it, for at most 2 minutes. The
worker re-pushes every five seconds while the ring is unacknowledged, and the
siren loops continuously. A ring is good for one trip for 2 minutes
(`DISPATCH_WINDOW_MS`, `apps/web/lib/services/trip.ts`), because the counter
packs the order before ringing; after that the ring stops, the board shows the
driver as available again, and the counter rings again. The worker's
`RING_REPEAT_WINDOW_MS` (`apps/worker/src/jobs/ringRepeater.ts`) and the web
app's `RING_WINDOW_MS` are pinned to it by tests. To change it, change all three.

**iPhone cannot do case A. Use Android for driver handsets.** Everything above
is written for Android and the difference is not cosmetic:

| | Android (installed) | iPhone (Home Screen) |
|---|---|---|
| Siren, app on screen | yes | yes |
| Siren, app backgrounded / phone locked | **yes** | **no** |
| Push when app is closed | yes (16.4+ equivalent) | yes, iOS 16.4+ only |
| Custom notification sound (a ringtone) | yes, per channel | **no** — system sound only |
| Vibration pattern | yes | **no** — ignored |
| Override Do Not Disturb / Focus | yes | **no** |
| Notification buttons | yes | **no** |

iOS suspends a backgrounded web app far harder than Android does, and starting a
NEW sound from a push while suspended is not something it permits — so on an
iPhone the siren is foreground-only, and a locked phone gets the plain system
notification tone and nothing else. The driver screen says so on an iPhone
rather than letting somebody tap "arm" and assume they are covered.

If a driver must use an iPhone, the workaround is to keep the app **open on
screen** while waiting for orders, with auto-lock set to Never while on shift.

**Verify it.** Open the app, tap once to arm, press the home button so it is
backgrounded, lock the phone, and have the counter ring. Expect a siren within a
second or two, continuing until *Got it — stop*.

**If case B still is not enough**, the only route to a true incoming-call
experience with the app fully closed — full screen, ringer volume, ignores silent
mode — is a small Android app wrapping this one (a TWA plus a high-priority FCM
message and a full-screen intent). That is a separate build and a Play Store
account, not a setting.

### Removing an employee or a branch
**Remove** always takes the person away today: the login stops working, they cannot punch,
they disappear from every list, and their username is freed so it can be used again. If they
come back they get a new account.

What they already did stays. Punches, advances and penalties are untouched, so:

- payroll for a month they worked **still lists them and still pays out** — scroll back and
  they are there
- from the following month they simply do not appear, because they have no shifts in it.
  Nothing expires them and no job sweeps them up; they are absent from a query about a month
  they were not there for.

An account with no records at all — a mistake, a test account — is erased outright instead,
row and all.

Branches work the same way, one scale up. Closing a branch **retires every employee, driver
and caller assigned to it** — an account only works at a branch, so one left filed against a
closed shop would look fine on the staff list and fail at the door every morning. The
confirmation says how many accounts will go before you press it, so **reassign anybody who is
moving to another branch first**. The owner's own admin account is never touched.

The punches and trips made there stay, so payroll for the months it was open still adds up,
and from the next month the branch appears nowhere. A branch nothing ever happened at is
deleted outright.

Closed branches are gone from the branches page and from every staff-assignment dropdown.
They stay in the punches filter marked `(closed)`, because their punches are still in the log.
`is_active=false` on its own remains what it was — archived, hidden behind **Show archived**,
and reversible from the branch edit form.

Erasing the RECORDS of somebody who worked is not a button and should not become one: payroll
rebuilds each month from the punches every time it is opened, so removing them rewrites months
that have already been paid. If it genuinely has to happen, it is a database job against a
fresh backup.

### Shifts that cross midnight
If somebody's shift STARTS near midnight, set the branch's **Working day starts at**
(Branches -> edit) to an hour when nobody is starting. Leave it at 0 for every other branch.

Why it matters: a shift belongs to the day it clocked IN. Dani starts at 23:00 some nights
and 00:00 others for the same shift, so at a midnight boundary those are different days -
one night stacked BOTH shifts onto one day (968 minutes against 8 owed, reported as 8h of
overtime worth $21) and left the next day looking absent. Two minutes decided which.

Pick an hour after the night shift ends and before the next one starts. For Hamra - coffee
mart, where dani finishes at 07:00 and khouder takes over at 07:00, **6** works: both of
dani's start times then name the same working day, and khouder and every day shift are
unaffected.

0 is the calendar day and is what every branch has by default, so this changes nothing until
you set it. Setting it does re-attribute PAST nights at that branch, which moves hours
between days - check the affected month's payroll after changing it.

### Check what the containers actually received
Env vars must be listed in `docker-compose.yml`, not just present in `.env`.
`web` and `worker` connect as `ems_app` (DEPLOY.md "APP_DB_PASSWORD"); only `migrate`
has the owner's password:
```bash
docker compose exec web env | grep -E 'VAPID|TELEGRAM|SENTRY|ENABLE_DEV'
docker compose exec worker env | grep -E 'VAPID|TELEGRAM'
```

---

## 6. Common alerts and what they mean

| Alert | Likely cause | First action |
|---|---|---|
| `GET /api/health` 503 `DB_UNREACHABLE` | `web` cannot query Postgres: down, or the password out of step with `.env` | `docker compose logs --tail=50 web db`; DEPLOY.md "If the app is broken after a deploy" |
| `GET /api/health` no answer | Container crashed, or killed at its memory limit (`web` 1 GB) | `docker compose ps`, `docker compose logs web`, `docker stats` |
| `GET /api/health/db` 503 | Postgres down or slow (>50ms) | `docker compose logs db`; check disk; check connection pool |
| Telegram **Backup missing** | No successful backup for 26 hours: cron misconfigured, disk full, or rclone auth expired | `tail /var/log/ems-backup.log`; run `backup.sh` manually; rotate rclone token |
| Telegram webhook 4xx spike | Bot token rotated but `TELEGRAM_BOT_TOKEN` env not refreshed | Update `/opt/ems/.env`, `docker compose up -d` |
| Telegram webhook 5xx spike | Network issue to api.telegram.org | Check VPS outbound; usually self-resolves |
| Sentry: an error tagged `job=<name>` | A worker job keeps failing (reported once an hour while it does, and at once after a recovery) | `docker compose logs --tail=100 worker` |
| Sentry: an error from a route | An exception escaped a route handler or page (a 500) | The event has the stack; `docker compose logs web` around that time |
| Drivers stop receiving the ring on locked phones | `VAPID_*` keys missing from the container, or rolled | `docker compose exec web env \| grep VAPID` and the same for `worker` (it sends the repeats); if rolled, each driver re-taps **Enable** |
| `/admin/punches` empty | Genuine fault — this page is backed by `/api/admin/punches` and should show history | Check `docker compose logs web` for the API error; verify the branch/date filters aren't excluding everything |

**A single `DB_SLOW` right after a deploy or restart?** The connection pool is cold
on the first query of a new process — one observed run measured 134ms against the
50ms limit, then 1-12ms on every call right after. This is separate from the
`/api/health` check the healthcheck and the production checklist use (one query with
a 3 s limit, speed ignored) — if you also check `/api/health/db` right after a
deploy, as is natural, re-run it a few seconds later before treating a `DB_SLOW`
as real. Only one that persists across repeated checks is worth chasing as actual
Postgres load or disk trouble.

**No Sentry alerts at all?** Sentry only initialises when both `SENTRY_DSN` is set
*and* `NODE_ENV=production`. Confirm with
`docker compose exec web env | grep SENTRY_DSN` (and the same for `worker`). Only
exceptions are reported - a `400`/`401`/`409` the app answered on purpose is not one.

**An unhealthy container is not restarted.** `restart: unless-stopped` brings back a
container that exits or is killed at its memory limit, not one whose healthcheck
fails: an `unhealthy` `web` or `worker` in `docker compose ps` keeps running as it is
until `docker compose restart web` (or `worker`). Logs are capped at 5 x 10 MB per
container, so `docker compose logs` reaches back days, not months.

---

## 7. Escalation

Single-owner shop: the owner is the escalation path and is reachable directly,
with a branch manager as backup. No on-call rota to maintain here.
