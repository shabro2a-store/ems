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
those requests fail for as long as the migration takes. Migrations here are
additive (new nullable columns and tables), so applying them while the old
containers are still serving is harmless.

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
start without `JWT_SECRET`.**
```bash
JWT_SECRET=<openssl rand -hex 32>          # REQUIRED — auth token signing secret
PUBLIC_APP_URL=https://app.shabro2a.com    # makes auth cookies Secure
ENABLE_DEV_ENDPOINTS=false                 # keep the GPS-bypass endpoints OFF in prod
# POSTGRES_PASSWORD=<optional>             # defaults to ems_dev_password if unset
# TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET  # see "Telegram alerts" below
```
Generate the secret once (won't overwrite an existing one):
```bash
grep -q '^JWT_SECRET=' .env || echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```
Changing `JWT_SECRET` invalidates all sessions (everyone logs in again).

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
- [ ] `ENABLE_DEV_ENDPOINTS=false`
- [ ] Owner password changed from `change-me`
- [ ] Each branch's location recorded on-site
- [ ] Cloudflare Access removed/bypassed (or every user's email whitelisted)
- [ ] One active **CALLER** account per branch — drivers cannot start a trip
      without a ring, so a branch with no caller cannot dispatch at all
- [ ] `docker compose ps` all healthy, `/api/health` returns ok
