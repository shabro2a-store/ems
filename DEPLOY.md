# Deploy

Production runs on a VPS with Docker Compose behind a Cloudflare Tunnel
(`https://app.shabro2a.com` → `localhost:3000`). Three containers: `db`
(Postgres), `web` (Next.js), `worker` (cron).

## Redeploy (the normal flow)
On the VPS:
```bash
cd /opt/ems
git pull
grep -q '^POSTGRES_PASSWORD=' .env || echo 'POSTGRES_PASSWORD=ems_dev_password' >> .env
docker compose build
docker compose up -d
```
**The `POSTGRES_PASSWORD` line is new in this release, and it is written for a server
that already has a Postgres volume** — every server deployed before this one. The
variable used to be optional and is probably absent from `/opt/ems/.env`; it is now
required, and the value must be the one the volume was *created* with,
`ems_dev_password`. Putting anything else there does not change the database, it only
changes what `web` and `worker` try to log in with, and every query then fails.
Rotating to a strong password is a **separate, later** step — see **Required
environment** below.

`up -d` runs the `migrate` service first - `prisma migrate deploy`, a no-op when
the pull added no migration - and starts `web` and `worker` only once it has exited
cleanly. New code therefore never serves a database still on the old schema. The
cost is a few seconds with the site down: the old containers stop when the new ones
are created, before the migration runs. **If the migration fails, `web` and `worker`
are not started**; `docker compose logs migrate` says why, and `docker compose up -d`
again resumes once it is fixed.

A migration that deletes data cannot be undone without a restore.
`20260815150000_drop_clock_windows` is one: it drops `Schedule`/`ScheduleOverride`/
`LeaveRequest`'s old `start_time`/`end_time` columns and permanently deletes every
`PenaltyWaiver` and `PenaltyAck` row referencing the retired `LATE`, `EARLY_LEAVE`
and `TIME_CHANGE` kinds. A server that has not run it yet should take a backup first
(`scripts/backup.sh`; see [RUNBOOK.md](RUNBOOK.md) §3).

First build takes ~3–5 min. The Postgres volume persists, so no data loss.

Verify the swap actually happened — `uptime_s` should be near zero:
```bash
docker compose ps
curl -s http://localhost:3000/api/health
```
If `uptime_s` is large, the containers were never replaced (usually a build that
failed earlier in the chain).

## Required environment (`/opt/ems/.env`)
`docker-compose.yml` reads these via `${VAR}` substitution. **The stack refuses to
start without `JWT_SECRET` or `POSTGRES_PASSWORD`** — `docker compose` aborts with
the variable's name before any container starts.

### `POSTGRES_PASSWORD` — read this before you generate anything
Postgres reads `POSTGRES_PASSWORD` **only when it initialises an empty data
directory**. Once the volume exists, the variable no longer sets the password — it
only tells `web` and `worker` what password to connect *with*. Put a different value
in `.env` and the two disagree: the database keeps the old password, every query from
the app fails authentication. `db`'s healthcheck is `pg_isready`, which does not
authenticate, so `docker compose ps` still reports `db` healthy; it is `web` that turns
unhealthy, because `/api/health` runs a real query and answers `503 DB_UNREACHABLE`.

So there are exactly two cases, and only one of them applies to this deploy:

- **Existing server (this deploy).** The volume already exists. Set the password the
  volume was created with — `ems_dev_password` — and change nothing else:
  ```bash
  grep -q '^POSTGRES_PASSWORD=' .env || echo 'POSTGRES_PASSWORD=ems_dev_password' >> .env
  ```
  Do **not** generate a random value here. Rotating to a strong password is a separate
  step, below, and is safe to do any time after the deploy is up.
- **First deploy, empty volume only.** No database exists yet, so this value becomes
  the password:
  ```bash
  # ONLY on a brand-new server with no Postgres volume — check with:
  #   docker volume ls | grep db_data     (no output = brand new)
  grep -q '^POSTGRES_PASSWORD=' .env || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
  ```

**Rotating the password on a running server** changes the database and `.env`
together, in that order:
```bash
docker compose exec db psql -U ems -d ems -c "ALTER USER ems WITH PASSWORD '<new>';"
# then put the same <new> value in .env and:
docker compose up -d
docker compose logs --tail=50 web    # must show no authentication errors
```
`docker compose exec db psql -U ems` works without a password (local socket, trust
auth), which is also the recovery path if the two ever get out of step: either
`ALTER USER` the database to match `.env`, or edit `.env` back to match the database.

### The rest
```bash
JWT_SECRET=<openssl rand -hex 32>          # REQUIRED — auth token signing secret
POSTGRES_PASSWORD=ems_dev_password         # REQUIRED — must match the existing volume; see above
PUBLIC_APP_URL=https://app.shabro2a.com    # makes auth cookies Secure
ENABLE_DEV_ENDPOINTS=false                 # keep the GPS-bypass endpoints OFF in prod
# TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET  # see "Telegram alerts" below
# VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT  # see "Web Push" below
# SENTRY_DSN=<optional>                    # error monitoring; off when unset
```
Adding a variable to `.env` is only half the job — it must also appear under the
service's `environment:` block in `docker-compose.yml`, or the container never
sees it. `.env.example` lists every variable the app reads.
Generate the signing secret once (won't overwrite an existing one):
```bash
grep -q '^JWT_SECRET=' .env || echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```
Changing `JWT_SECRET` invalidates all sessions (everyone logs in again).

### If the app is broken after a deploy but `db` looks healthy
`pg_isready` answers before authentication, so a healthy `db` proves nothing about
whether the app can log in. Check the app's own logs:
```bash
docker compose logs --tail=50 web     # look for: password authentication failed for user "ems"
```
That message means `POSTGRES_PASSWORD` in `.env` does not match the database. Fix it
with one of the two options in the rotation note above, then `docker compose up -d`.

## Network exposure
`db` publishes to `127.0.0.1:5433` — the host only. Docker inserts its own
iptables rules *ahead* of UFW, so a `0.0.0.0` publish stays reachable from the
internet even with the firewall closed; the bind address is what actually gates
it. Containers are unaffected: they reach Postgres as `db:5432` over the compose
network. Check it after a deploy — the second command must refuse:
```bash
docker compose port db 5432          # expect 127.0.0.1:5433
psql "postgresql://ems:<password>@<the VPS public IP>:5433/ems" -c 'select 1'
```
`web` publishes to `127.0.0.1:3000` the same way. It used to be `0.0.0.0:3000`,
which let anyone who learned the VPS address skip the tunnel — and with it
Cloudflare — and talk to the app directly. The tunnel is unaffected as long as
`cloudflared` runs **on the host**, the layout these docs describe
(`https://app.shabro2a.com` → `localhost:3000`).

**Before the first deploy with this change**, confirm that:
```bash
systemctl status cloudflared         # expect: active (running)
```
A `cloudflared` running in its own container reaches the host over the docker
bridge, not loopback, and the loopback bind would take the site down. If that is
the layout, put `'3000:3000'` back in `docker-compose.yml` until `cloudflared`
moves to the host. After the deploy, from another machine this must refuse:
```bash
curl -m 5 http://<the VPS public IP>:3000/api/health
```

## Seed (first deploy only, on an empty database)
After the first `docker compose up -d` has created the tables (the `migrate` service):
```bash
docker compose run --rm -w /app/packages/db web node_modules/.bin/tsx prisma/seed.ts
```
Seed creates `owner` (admin) + two branches + `emp1`/`emp2`, all password `change-me`.
The first `owner` login asks for a new password before anything else. Deactivate
`emp1`/`emp2` once real staff exist.

The seed only fills an **empty** database. On one that already has any user or
branch it prints `seed: refused - the database already has data` and changes
nothing, so it is never part of a redeploy (schema changes are `migrate deploy`,
above).

## Web Push (caller ring on locked phones)
Optional but recommended. Without these keys the caller still rings drivers with the
in-app alarm (while the app is open); with them, the ring also reaches a **locked/closed**
phone. Generate one keypair (once) — this prints the two lines ready to paste:
```bash
docker compose run --rm web node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey);console.log('VAPID_PRIVATE_KEY='+k.privateKey)"
```
Then open `nano /opt/ems/.env`, paste those two lines (with the real values), add
`VAPID_SUBJECT=mailto:you@shabro2a.com`, save, and recreate `web` and `worker` - web
sends the first ring, the worker repeats it every five seconds until it is answered:
```bash
docker compose up -d
docker compose exec worker env | grep VAPID   # expect all three lines
```
Do NOT paste the `VAPID_*` lines straight into the shell — they belong in the `.env` file.
Rolling the keys invalidates existing device subscriptions (drivers re-enable alerts).
On each driver's phone: open the driver screen and tap **Enable** on the alerts banner.
**iPhone drivers** must first **Add to Home Screen** (Share → Add to Home Screen) and open
the app from the home-screen icon — iOS only allows web push for installed PWAs (iOS 16.4+).

## Telegram alerts (optional)
Without a bot token the app still works — alerts just stay in the dashboard's
**Needs attention** panel. With one, the same events also reach the admin's phone.

1. On your phone, message **@BotFather** → `/newbot`. It returns a token.
2. Put the token and a webhook secret in `/opt/ems/.env` (generate the secret with
   `openssl rand -hex 16`):
   ```bash
   TELEGRAM_BOT_TOKEN=<the token from BotFather>
   TELEGRAM_WEBHOOK_SECRET=<random hex>
   ```
   Without it the bot refuses every message sent to it (/start and /stop do
   nothing), and the Telegram card in the app says so.
3. `docker compose up -d` to pick up the new environment.
4. Point Telegram at the webhook (substitute both values):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://app.shabro2a.com/api/telegram/webhook" -d "secret_token=<SECRET>"
   ```
   Expect `{"ok":true,...}`.
5. In the app as admin: **Dashboard → Telegram alerts → Connect**. It shows the bot's
   link (`https://t.me/<bot>`). Open it on the phone that should receive the alerts and
   press **START**. That is the whole of it — no code, nothing to expire.
6. Press **Send test** on the same card. Nothing before this step proves a message can
   actually be delivered: a token short one character and a bot the phone later blocked
   both read as connected. If it fails, the message names which to fix.

**There is no chat id to configure.** The phone binds itself; the id it reports is stored
against the admin account. Nothing about the handset lives in `.env`, so replacing it is a
press of START and nothing else.

**Binding is open on purpose.** The person with the dashboard and the person with the phone
are not the same person — the owner logs in, the manager carries the work handset and has no
account — so anything that had to be read off a screen could not be used by the person who
needed it. The bot only ever *sends*; nothing in the app can be reached through it, so a
wrong chat would see the alert feed, never control of anything.

**First come, and that is the only rule.** The first chat to press START keeps the alerts.
A second chat is told to use Disconnect first, because an open bind that let any later
`/start` take over would silently move the alerts off the work phone and nothing anywhere
would say why.

**To move or stop the alerts:** press **Disconnect** on the card, or send `/stop` to the bot
from the phone itself. Either clears it, tells the chat, and is audited.

## Cloudflare
- **Tunnel**: keep it — it provides HTTPS and hides the origin IP. Required for
  browser geolocation (GPS only works over HTTPS).
- **Access (email OTP gate)**: this is a SEPARATE gate Cloudflare puts in front of
  the whole site, before the app's own login. It authenticates by **email**, so it
  will block employees, who log in with **username + password** (no email). The app
  has its own robust auth (JWT, bcrypt, CSRF, rate limiting, role checks), so for
  normal use **remove/Bypass the Access policy** and let the app's login do the
  gating. Only keep Access if you specifically want an extra email-whitelist gate
  (and then you must add every user's email to it).

## Branch GPS (critical for punching)
A new branch defaults to coordinates 0,0 — nobody can punch until you record it.
On your **phone, standing at the branch**: Branches → the branch → **📍 Record
location**. If punches fail on weak indoor GPS, raise the branch's **Max GPS
accuracy** and/or radius via Edit.

## Production checklist
- [ ] `JWT_SECRET` set to a real random value (not the dev placeholder)
- [ ] `POSTGRES_PASSWORD` present in `.env` and **matching the existing Postgres
      volume** (`ems_dev_password` on any server deployed before this release) — a
      random value here breaks every query while `docker compose ps` still shows
      `db` healthy. Rotate it *after* the deploy is up, via `ALTER USER`
- [ ] `docker compose logs --tail=50 web` shows no `password authentication failed`
- [ ] `docker compose port db 5432` reports `127.0.0.1:5433`, and Postgres refuses
      a connection to the VPS's public IP
- [ ] `ENABLE_DEV_ENDPOINTS=false`
- [ ] Owner password changed from `change-me`
- [ ] Each branch's location recorded on-site
- [ ] Each employee's weekly shift hours set (a weekday left unset means any work
      that day counts as overtime, not a shortfall)
- [ ] Cloudflare Access removed/bypassed (or every user's email whitelisted)
- [ ] One active **CALLER** account per branch — drivers cannot start a trip
      without a ring, so a branch with no caller cannot dispatch at all
- [ ] `docker compose ps` all healthy, `/api/health` returns ok (it queries the database)
- [ ] `docker compose ps -a migrate` shows it exited with code 0
