# Shabro2a — Employee Management System

Time-and-attendance for a multi-branch supermarket in Beirut: geofenced punch
in/out, driver trips, monthly payroll (money in integer cents), leave/day-off
scheduling, cash advances, and a Telegram-notifying background worker.

- **Admin** (owner): live operations dashboard with a **Needs attention** work queue
  (penalties, flags, advance and leave requests — each action reports what it changed),
  employees + weekly schedules, branches + GPS geofences, punch log + corrections,
  payroll + PDF export.
- **Employee / Driver** (phone): one-tap geofenced check in/out or trip out/back,
  advances, leave and hours-change requests, and their own payslip.
- **Caller** (POS tablet): rings drivers for pickups. The board rotates by fair turn —
  whoever just went out sinks to the bottom. Drivers can only leave once rung.

## Docs
- [SYSTEM_MAP.md](SYSTEM_MAP.md) — what the system does (roles, data model, rules, worker jobs).
- [API.md](API.md) — the HTTP API contract.
- [DEPLOY.md](DEPLOY.md) — production deploy (VPS + Docker + Cloudflare Tunnel).
- [RUNBOOK.md](RUNBOOK.md) — operations (backups, health, incidents).
- [AGENTS.md](AGENTS.md) — code conventions.

## Tech stack
Next.js 14 (App Router) · PostgreSQL 16 + Prisma · node-cron worker ·
pnpm workspaces · Tailwind design system · react-pdf.

## Local development
```bash
docker compose up -d db                       # Postgres on :5433
pnpm install
pnpm --filter db exec prisma generate
pnpm --filter db exec prisma migrate deploy   # or `prisma migrate dev` for a fresh DB
pnpm --filter db db:seed                       # owner + 2 branches + emp1/emp2 (password: change-me)

# env for the web/worker processes:
#   DATABASE_URL=postgresql://ems:ems_dev_password@localhost:5433/ems
#   JWT_SECRET=<any 32+ char string for local>
#   ENABLE_DEV_ENDPOINTS=true   # shows the Dev IN/OUT GPS bypass (laptops have no real GPS)

pnpm --filter web dev      # http://localhost:3000
pnpm --filter worker dev   # cron jobs
```

Default logins after seeding (all `change-me`): `owner` (admin), `emp1`/`emp2` (employee).

## Checks
```bash
pnpm -r typecheck
pnpm -r test        # unit tests + HTTP integration tests
```
The HTTP integration tests need the web app running at `TEST_BASE_URL`
(default `http://127.0.0.1:3000`) and a reachable Postgres. See `.github/workflows/ci.yml`.

## Layout
```
apps/web      Next.js app (UI + API routes + middleware)
apps/worker   node-cron background jobs (flags, alerts, daily summary)
packages/db   Prisma schema, migrations, seed
packages/time Asia/Beirut date helpers
packages/notify Telegram / console notifier
packages/pdf  Payroll PDF (react-pdf)
```
