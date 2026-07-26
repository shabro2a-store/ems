# Deploy

Production runs on a VPS with Docker Compose behind a Cloudflare Tunnel
(`https://app.shabro2a.com` → `localhost:3000`). Three containers: `db`
(Postgres), `web` (Next.js), `worker` (cron).

## Redeploy (the normal flow)
On the VPS:
```bash
cd /opt/ems
git pull
docker compose up -d --build
```
`--build` is required — without it Docker reuses the old image. First build ~3–5 min.
The Postgres volume persists, so no data loss. **If the pull added a new Prisma
migration** (`packages/db/prisma/migrations/…`), also run migrate deploy afterwards —
the app expects the new columns:
```bash
docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy
```

Verify:
```bash
docker compose ps                         # web/worker "Up (healthy)"
curl -s http://localhost:3000/api/health  # {"ok":true,...}
```

## Required environment (`/opt/ems/.env`)
`docker-compose.yml` reads these via `${VAR}` substitution. **The stack refuses to
start without `JWT_SECRET`.**
```bash
JWT_SECRET=<openssl rand -hex 32>          # REQUIRED — auth token signing secret
PUBLIC_APP_URL=https://app.shabro2a.com    # makes auth cookies Secure
ENABLE_DEV_ENDPOINTS=false                 # keep the GPS-bypass endpoints OFF in prod
# POSTGRES_PASSWORD=<optional>             # defaults to ems_dev_password if unset
# TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET  # once notifications are wired
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
- [ ] `docker compose ps` all healthy, `/api/health` returns ok
