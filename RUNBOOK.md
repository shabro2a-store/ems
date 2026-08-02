# RUNBOOK — Supermarket EMS

Operational procedures for local dev, production deploy, and on-call response.

---

## 1. Local dev quickstart

Prereqs: Node 20, pnpm 9, Docker (for the Postgres dev DB).

```bash
git clone <repo>
cd <repo>
pnpm install
docker compose up -d db
pnpm --filter db prisma migrate dev
pnpm --filter db prisma db seed
pnpm dev
# web:    http://localhost:3000
# worker: cron runner in foreground (Ctrl+C to stop)
```

Seed credentials (development only — never in prod):
- Admin: `owner` / `change-me`
- Sample employee/driver per branch: see `packages/db/prisma/seed.ts`

Run tests:
```bash
pnpm --filter web test           # unit + integration (needs web server up for integration)
pnpm typecheck                    # typecheck entire monorepo
```

---

## 2. Production deploy via Coolify

Assumes Coolify is already installed on the VPS.

1. **Create the application** in Coolify:
   - Source: GitHub repo, branch `main`.
   - Build pack: `Docker Compose`.
   - Compose file: `docker-compose.prod.yml`.

2. **Provision the Postgres DB** as a separate Coolify resource (not in the compose file).
   - Postgres 16, persistent volume, expose a strong password as a Coolify secret.

3. **Set environment variables** in Coolify (the `.env` file is **not** shipped):
   - `DATABASE_URL=postgresql://ems:<password>@<db-host>:5432/ems`
   - `JWT_SECRET=<openssl rand -hex 32>`
   - `NODE_ENV=production`
   - `PUBLIC_APP_URL=https://app.example.com`
   - `TELEGRAM_BOT_TOKEN=…` (Phase 5b)
   - `TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 16>`
   - `SENTRY_DSN=https://…@sentry.io/…`
   - `BACKUP_GPG_PASSPHRASE_PATH=/run/secrets/backup.key`
   - `RCLONE_CONFIG=/root/.config/rclone/rclone.conf`

4. **Point Cloudflare** at the Coolify origin (`app.example.com` → VPS IP, Full strict SSL).

5. **First deploy**: push to `main` triggers Coolify build. Watch logs for:
   - `prisma migrate deploy` succeeds.
   - `next build` completes.
   - `node server.js` starts and `/api/health` returns 200.

6. **Configure the UptimeRobot monitor** on `https://app.example.com/api/health` (every 5 min).

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
1. Owner adds via `https://app.example.com/admin/branches` → fill lat/lng (drop pin in Google Maps), radius (default 50m), trip threshold.
2. Recompute payroll unchanged — payout uses branches only for filtering if needed.
3. Update `RUNBOOK.md` with the new branch's coordinates.

### Rotate `JWT_SECRET`
- **All users get logged out.** Set a new value in Coolify env, redeploy.
- No data loss; cookies become invalid, users re-login.

### Deploy a hotfix
- Push to `main` → Coolify auto-deploys (if webhook configured).
- Watch Coolify logs for the new container starting healthy (`/api/health` 200).
- No manual DB migrations required for hotfixes that don't touch `schema.prisma`.

### Pause / resume the worker
- `docker compose -f docker-compose.prod.yml stop worker` — cron jobs halt; no missed-checkout detection runs.
- Restart with `… start worker`.
- Owner dashboard stays available; only cron-side alerts pause.

---

## 6. Common alerts and what they mean

| Alert | Likely cause | First action |
|---|---|---|
| `GET /api/health` 3xx/5xx | Container crashed, or OOMKilled | `docker logs <web>`; check memory limit |
| `GET /api/health/db` 503 | Postgres down or slow (>50ms) | `docker logs <db>`; check disk; check connection pool |
| Backup didn't run (no new file in `/var/backups/ems/`) | Cron misconfigured, or rclone auth expired | Run `backup.sh` manually with `--verbose`; rotate rclone token |
| Telegram webhook 4xx spike | Bot token rotated but `TELEGRAM_BOT_TOKEN` env not refreshed | Update env, redeploy worker |
| Telegram webhook 5xx spike | Network issue to api.telegram.org | Check VPS outbound; usually self-resolves |
| Sentry alert: spike of `UNAUTHORIZED` | JWT_SECRET rotated (expected) or cookie domain misconfigured | Check most recent deploy; correlate with JWT_SECRET changes |
| Sentry alert: spike of `INVALID_INPUT` | Schema drift between client + server | Verify both are on latest `main` |
| `/admin/punches` shows empty | Pre-existing data-source gap (`/api/me/today` has no history) | Owner uses payroll export instead |

---

## 7. Emergency contacts

- **Kyvera engineering**: <on-call phone + email>
- **Client primary**: <owner name + phone>
- **Hetzner VPS support**: <support ticket URL>
- **Cloudflare**: <account dashboard>
- **Telegram bot**: <@botfather handle>

---

## 8. Glossary

- **Asia/Beirut**: the only timezone the business logic speaks. UTC stored in DB; conversion at display time via `packages/time`.
- **RateChange**: append-only table; payout reads only from this. `User.hourly_rate_cent` is display-only.
- **Flag**: notify-able event (WATCHED / MISSED_CHECKOUT / TRIP_OVER_THRESHOLD). Insert-only except `notified_at`.
  Note `notified_at` currently means three things at once — alert sent, admin dismissed, and
  auto-resolved by punching. See SYSTEM_MAP §9; it is why the 23:30 sweep can clear a WATCHED
  flag nobody reviewed. `TRIP_OVER_THRESHOLD` is declared but never written.
- **Penalty**: never stored. Computed from schedule vs punches at read time. A **PenaltyWaiver**
  revokes one (money returns); a **PenaltyAck** upholds one (money unchanged, notice cleared).
- **PenaltyAck vs PenaltyWaiver**: only the waiver touches pay. If an employee disputes a
  deduction, look for a waiver row — an ack means the admin reviewed it and let it stand.
- **AuditLog**: REVOKE UPDATE/DELETE; only inserts.
