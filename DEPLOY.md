# Deploy

Production runs on a VPS with Docker Compose behind a Cloudflare Tunnel
(`https://app.shabro2a.com` → `localhost:3000`). Three containers: `db`
(Postgres), `web` (Next.js), `worker` (cron).

## Redeploy (the normal flow)
On the VPS:
```bash
cd /opt/ems
git pull
docker compose build
docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy
docker compose up -d
```
Build first, migrate second, swap last. `migrate deploy` is a no-op when the pull
added no migration, so this order is always safe to run. It matters because the
new image's code expects the new columns: bringing the containers up *before*
migrating serves requests against a database that is still on the old schema, and
those requests fail for as long as the migration takes. Most migrations here are
additive (new nullable columns and tables), so applying them while the old
containers are still serving is harmless — **the migration in this release is not
one of those.**

**This deploy's migration is destructive, and the order above is load-bearing, not
just good practice.** It drops `Schedule`/`ScheduleOverride`/`LeaveRequest`'s old
`start_time`/`end_time` columns and retires the `LATE`, `EARLY_LEAVE` and
`TIME_CHANGE` enum values for good (Postgres can only replace an enum type, not
trim one value out of it). The new image's Prisma client no longer has those
values in its generated types at all. If the new containers ever serve traffic
*before* `prisma migrate deploy` has run, every read that touches a
`PenaltyWaiver`, `PenaltyAck`, `ScheduleOverride` or `LeaveRequest` row still
carrying one of the retired values throws a Prisma enum-deserialisation error —
and unlike the additive case above, that does not clear up once the migration
finishes; it keeps failing on that data until it runs. Run the four commands in
the order given; do not let `docker compose up -d` happen ahead of the migrate
step. The same migration also **permanently deletes** every `PenaltyWaiver` and
`PenaltyAck` row referencing the retired kinds — irreversible without a restore.
Take a backup first if you want the option to go back (`scripts/backup.sh`; see
[RUNBOOK.md](RUNBOOK.md) §3).

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
```bash
JWT_SECRET=<openssl rand -hex 32>          # REQUIRED — auth token signing secret
POSTGRES_PASSWORD=<openssl rand -hex 24>   # REQUIRED — database password, no default
PUBLIC_APP_URL=https://app.shabro2a.com    # makes auth cookies Secure
ENABLE_DEV_ENDPOINTS=false                 # keep the GPS-bypass endpoints OFF in prod
# TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET  # see "Telegram alerts" below
# VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT  # see "Web Push" below
# SENTRY_DSN=<optional>                    # error monitoring; off when unset
```
`POSTGRES_PASSWORD` is only read when Postgres initialises its data directory, so
on an **existing** install it must match the password the volume was created with
(`ems_dev_password` on any server deployed before this release). Rotating it is a
separate operation:
```bash
docker compose exec db psql -U ems -d ems -c "ALTER USER ems WITH PASSWORD '<new>';"
# then put the same value in .env and: docker compose up -d
```
Adding a variable to `.env` is only half the job — it must also appear under the
service's `environment:` block in `docker-compose.yml`, or the container never
sees it. `.env.example` lists every variable the app reads.
Generate the secrets once (won't overwrite existing ones):
```bash
grep -q '^JWT_SECRET=' .env || echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
grep -q '^POSTGRES_PASSWORD=' .env || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
```
Changing `JWT_SECRET` invalidates all sessions (everyone logs in again).

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
`web` still publishes on `0.0.0.0:3000`, so anyone who learns the origin IP can
reach the app directly and bypass the tunnel (the app's own login still gates
every request). If `cloudflared` runs **on the host** — the layout these docs
describe, `https://app.shabro2a.com` → `localhost:3000` — then narrowing it costs
nothing:
```yaml
    ports:
      - '127.0.0.1:3000:3000'
```
Confirm `cloudflared` is a host service (`systemctl status cloudflared`) before
making that change: a `cloudflared` running in its own container reaches the host
over the docker bridge, not loopback, and a loopback bind would take the site
down.

## Migrations & seed (first deploy, or after schema changes)
```bash
docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy
docker compose run --rm -w /app/packages/db web node_modules/.bin/tsx prisma/seed.ts
```
Seed creates `owner` (admin) + two branches + `emp1`/`emp2`, all password `change-me`.
Change the owner password immediately (top bar → **Password**).

## Web Push (caller ring on locked phones)
Optional but recommended. Without these keys the caller still rings drivers with the
in-app alarm (while the app is open); with them, the ring also reaches a **locked/closed**
phone. Generate one keypair (once) — this prints the two lines ready to paste:
```bash
docker compose run --rm web node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey);console.log('VAPID_PRIVATE_KEY='+k.privateKey)"
```
Then open `nano /opt/ems/.env`, paste those two lines (with the real values), add
`VAPID_SUBJECT=mailto:you@shabro2a.com`, save, and recreate `web`:
```bash
docker compose up -d
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
   Set the secret explicitly — `docker-compose.yml` otherwise falls back to the
   literal `dev_webhook_secret_change_in_prod`.
3. `docker compose up -d` to pick up the new environment.
4. Point Telegram at the webhook (substitute both values):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://app.shabro2a.com/api/telegram/webhook" -d "secret_token=<SECRET>"
   ```
   Expect `{"ok":true,...}`.
5. In the app as admin: **Dashboard → Telegram alerts → Connect**. It shows a
   6-digit code; send `/start <code>` to the bot from the phone that should receive
   alerts.

**Binding is code-gated on purpose.** The webhook secret only proves a request came
from Telegram, not *who* messaged the bot, so a bare `/start` is refused — otherwise
anyone who discovered the bot could redirect the alert feed to themselves. Codes are
derived from `JWT_SECRET`, last 10 minutes, and are shown only to a logged-in admin.
Changing `JWT_SECRET` invalidates outstanding codes (existing bindings survive).

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
- [ ] `POSTGRES_PASSWORD` set to a real random value (not `ems_dev_password`)
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
- [ ] `docker compose ps` all healthy, `/api/health` returns ok
