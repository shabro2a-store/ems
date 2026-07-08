# Technical Plan & Specification — Supermarket EMS

**Project:** Employee Management System (Supermarket, 3 branches, Beirut)
**Provider:** Kyvera Agency
**Document version:** v1.1 — spec audit pass (contradictions purged, decisions #31–#35 added)
**Status:** LOCKED. Ready to scaffold.
**Goal of this document:** A build-ready plan that an agent (or developer) can execute end-to-end without re-asking architectural questions.

---

## How to read this document

**§0–§9** describe the system as it will be built. **§10** is the timeline. **§11–§17** are reference (decisions, schema, open items).

**Authoritative sections for build questions:** §6 (data model), §7 (endpoints), §8 (services & rules), §9 (security). If anything elsewhere contradicts these four, **these four win**.

---

## 0. TL;DR

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 14 (App Router) + Tailwind, English UI, mobile-first PWA | Single deployable, PWA covers "app-like" without App Store tax |
| Auth | Username/password + JWT (httpOnly cookie), bcrypt. **Admin sets/resets passwords.** | No self-serve reset, no email, no MFA |
| DB | PostgreSQL 16, Prisma ORM | Single source of truth |
| API | Next.js Route Handlers, REST-shaped, Zod-validated | One repo, one deploy unit |
| Geofence | Server-side haversine, 50m default, per-branch configurable | Zero external API cost; the product's trust core |
| Real-time | **None.** 10s polling on `GET /api/admin/now` | Soketi/Pusher dropped — Telegram handles true urgency |
| Push alerts | Telegram Bot API behind channel-agnostic `Notifier` interface | Telegram is **read-only** (decision #11) |
| Cron | `node-cron` in dedicated worker process | Time-based events only; action-based events fire inline |
| Currency | **USD cents** (`amount_cent` = USD cents, single-currency v1) | Decision #35 |
| Timezone | **Asia/Beirut.** Timestamps stored UTC; all schedule/flag comparisons in `Asia/Beirut` via `date-fns-tz`; DST handled by the library | Decision #31 |
| Hosting | Coolify on Hetzner VPS, Cloudflare proxy, custom domain | One dashboard |
| Backups | `pg_dump` nightly → gpg → local + rclone Google Drive | PRD §9 |
| Observability | Sentry + structured logs + Telegram error alerts | Production sanity |
| Testing | Vitest (unit) + Playwright (E2E mobile) | Backend-first build |

**Two deployable units:** `web` (Next.js), `worker` (cron + notifier), `db` (Postgres). All in one Docker compose stack.

---

## 1. Non-Negotiable Principles

1. **Honest system, human enforcement.** No silent auto-deductions, no continuous GPS.
2. **One source of truth = Postgres.** Audit trail is append-only.
3. **Mobile-first.** Floor staff tap big buttons. Owner uses phone for flags.
4. **Privacy by default.** Location only at the moment a button is pressed.
5. **Configurable, not hard-coded.** Branches, radii, rates, schedules are rows.
6. **Channel-agnostic notifications.** Telegram is v1; the `Notifier` interface is the contract.
7. **Read-only outputs.** PDFs are the canonical "share with accountant" surface.
8. **Telegram is read-only.** Owner reads, decides in the dashboard. (Decision #11)

---

## 2. Architecture Overview

```
                ┌───────────────────────────────┐
                │       Cloudflare (DNS/CDN)    │
                └───────────────┬───────────────┘
                                │ HTTPS
                ┌───────────────▼───────────────┐
                │    Coolify (reverse proxy)    │
                │       on Hetzner VPS          │
                └───────────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
┌───────▼────────┐     ┌────────▼────────┐     ┌───────▼────────┐
│  web (Next.js) │     │ worker (cron)   │     │  postgres 16   │
│  App Router    │◄────┤  node-cron jobs │     │  (Docker vol)  │
│  + Route API   │     │  notifier       │     └───────┬────────┘
│  + PDF render  │     │  (no callbacks) │             │
└───────┬────────┘     └─────────────────┘             │
        │                                               │
        └─────────────────────┬─────────────────────────┘
                              │
                ┌─────────────▼─────────────┐
                │   Off-VPS: Google Drive   │  (rclone backups)
                └───────────────────────────┘
```

Two services + db. Admin dashboard polls one endpoint. No WebSocket, no Soketi, no Pusher.

### 2.1 Process Inventory

| Process | Runtime | Purpose |
|---|---|---|
| `web` | Node 20, Next.js standalone | UI + REST API + PDF render + payroll endpoint |
| `worker` | Node 20, long-running | Time-based cron jobs, Telegram alert sender (outbound only) |
| `db` | Postgres 16 (Docker) | Authoritative state |
| `backup` | Cron job inside worker container | `pg_dump`, encrypt, upload |

---

## 3. Tech Stack — Detailed

### 3.1 Next.js 14 (App Router)

- **Why:** PRD §8 mandates Next.js. App Router gives server components (lighter mobile JS) and colocated Route Handlers.
- **File layout:**
  ```
  apps/web/
    app/
      (public)/login           → login page
      (app)/employee/...       → employee PWA screens
      (app)/driver/...         → driver screens
      (app)/admin/...          → owner dashboard
      api/                     → Route Handlers
    components/                → shared UI (Button, Banner, Card)
    lib/                       → services, geofence, notify, pdf
    public/                    → icons, manifest.json, sw.js
    middleware.ts              → auth + role guard
  ```
- **PWA:** `manifest.json`, minimal service worker for offline shell (Add-to-Home-Screen verified).
- **Rendering:**
  - Employee/Driver screens → client components (live "minutes since IN" display, banner).
  - Admin dashboard → server components for tables + small client island polling `/api/admin/now` every 10s.

### 3.2 Tailwind CSS

Buttons ≥ 56×56 px tap target. Color semantics:
- 🟢 green (primary): check-in, approve
- 🔴 red (danger): check-out, dismiss
- 🟡 amber (warn): late/early flags
- 🟠 orange: driver actions
- 🔵 blue (info): summaries, info

### 3.3 PostgreSQL + Prisma

- **Schema source of truth:** §6.
- **Append-only tables:** `punch`, `rate_change`, `adjustment`, `audit_log`. No UPDATE/DELETE in services.
- **Effectively append-only (one allowed mutation):** `flag` — created by cron, `notified_at` updated once by resolution (§8.5). Original row content never altered.
- **Mutable tables:** `user`, `branch`, `schedule`, `schedule_override`, `leave_request`, `trip`, `advance`, `idempotency_key`, `rate_limit_bucket`.
- **Migrations:** `prisma migrate deploy` on container start, with raw-SQL migrations for partial indexes, CHECK constraints, and `REVOKE` statements.
- **Connection pooling:** Prisma default pool (10 connections). PgBouncer unnecessary at this scale.

### 3.4 Auth — JWT in httpOnly cookies

- `POST /api/auth/login` → bcrypt verify → issue JWT in httpOnly, SameSite=Lax, Secure cookie.
- `middleware.ts` decodes JWT and attaches `userId`, `role`, `branchId` to request headers for server components.
- Route handlers run `requireRole('employee'|'driver'|'admin')`.
- **Session expiry by role** (decision #13):
  - **Employee** (non-driver): 2 hours after last API activity.
  - **Driver**: schedule_end + 30 minutes for that day.
  - **Driver with no schedule that day** (decision #34): falls back to the employee 2h-idle rule.

### 3.5 Geofencing — Server-side haversine (`lib/geofence.ts`)

```ts
verifyWithinGeofence(
  lat: number, lng: number,
  branches: Branch[],
  accuracy: number
): { ok: boolean; nearest?: Branch; distance?: number; reason?: 'TOO_FAR'|'LOW_GPS_ACCURACY' }
```

Rules:
- Reject if `accuracy > branch.gps_accuracy_max_m` (default 100m).
- Compute great-circle distance for every **active** branch, return nearest with `distance < branch.gps_radius_m + accuracy`.
- The punch/trip endpoint passes the user's **assigned branch** (`user.branch_id`) to `verifyWithinGeofence` — driver can only punch at their own branch. Geofence check is `distance < branch.gps_radius_m + accuracy` against that single branch.
- **Why server-side:** client-trusted coordinates would defeat the entire trust layer.

### 3.6 Real-time — DROPPED

Admin dashboard polls `GET /api/admin/now` every 10s. Single endpoint, single Prisma query. Telegram handles true urgency.

### 3.7 Notifications — Channel-agnostic `Notifier`

```ts
// lib/notify/types.ts
export interface Notifier {
  send(payload: NotificationPayload): Promise<void>;
}
```

- **v1 implementations:** `ConsoleNotifier` (dev), `TelegramNotifier` (prod).
- **v2 path:** `WhatsAppNotifier` behind the same interface — no callers change.
- **Bot scope (~200 lines):** `/start` from admin → bot writes `chat_id` to `User.telegram_chat_id` (persistent binding, survives logout/reinstall). Sends alerts + deep links. **No callback queries. No inline buttons.** Read-only by design (decision #11).
- Daily closing summary at 23:00 Asia/Beirut (if toggle on).
- Webhook registered via `setWebhook` against the production domain, protected with `X-Telegram-Bot-Api-Secret-Token`.

### 3.8 PDFs — `@react-pdf/renderer`

- **Why:** No Chromium in prod. Deterministic output.
- **v1 scope:** **payroll PDF only.** Other 3 templates (branch attendance, advances ledger, driver stats) deferred — architecture in place, layouts are quotable later.
- **Endpoint:** `GET /api/admin/reports/payroll?month=YYYY-MM` → streams PDF, `Content-Disposition: attachment`.

### 3.9 Cron — `node-cron` in dedicated worker

| Cron | Job | Type |
|---|---|---|
| `*/1 * * * *` | watched-flag detector (no IN by schedule+30min) | Time-based |
| `*/1 * * * *` | missed-checkout detector — fires if user still has open IN at **schedule_end + 30 min + 5 min buffer** (decision #32, see §8.6) | Time-based |
| `*/1 * * * *` | trip threshold (open trips > branch.trip_threshold_min, dedup per trip) | Time-based |
| `*/30 * * * *` | driver-stale (no BACK press in 4h) → Telegram "Driver X marked OUT for 4h+, no BACK press. Phone dead or stranded." | Time-based |
| `0 2 * * *` | nightly backup + retention prune + idempotency-key cleanup | Time-based |
| `0 23 * * *` | daily closing summary to owner (if toggle on) | Time-based |
| `30 23 * * *` | end-of-day watcher — surface all WATCHED flags with `notified_at IS NULL` to dashboard "Unresolved absences today" panel | Time-based |

**Action-based events do NOT use cron** (decision #10). They fire inline in the API handler:
- Punch resolves a `WATCHED` flag → contextual alert sent inline (§8.5).
- Punch attempts while driver has open trip → blocked inline (§4).
- Advance submission → Telegram deep-link sent inline.

### 3.10 Backups

```
pg_dump -Fc -d ems -f /tmp/ems-$(date +%F).dump
gpg --symmetric --batch --passphrase-file /run/secrets/backup.key
cp to /var/backups/ems/   (retention: 7 daily + 4 weekly + 3 monthly)
rclone copy /var/backups/ems/ gdrive:EMS-Backups/ --max-age 30d
```

Integrity check: `pg_restore --list` on most recent dump. Failure → Telegram to owner.

### 3.11 Observability

- **Sentry** for server-side exceptions (`@sentry/nextjs`).
- **Structured JSON logs** to stdout (Coolify log drain).
- **Health endpoints:** `/api/health` and `/api/health/db`.
- **Uptime:** UptimeRobot free tier on `/api/health`.

### 3.12 Testing

- **Vitest** for `lib/*` — geofence math, payout calc, notifier, rate history rule, timezone conversions, watched-flag resolution.
- **Playwright** for one mobile E2E: login → check-in (mocked GPS in test branch) → admin sees presence.
- **No test on real employee data** (single source of truth).

---

## 4. Domain Model — Patterns

### 4.1 Layered architecture

- `app/api/*/route.ts` → thin handler: Zod parse, auth check, return JSON.
- `lib/services/*` → business logic, no `Request`/`Response`.
- `lib/db/*` → Prisma client only; never reaches into another layer.

### 4.2 Idempotency + rate limit (decision #14)

- **Idempotency-Key header** on state-changing endpoints: `/api/me/punch`, `/api/me/trip/*`, `/api/me/advances`, `/api/me/leave`, all `/api/admin/*` mutations. **Excludes** `/api/auth/login` (login is not idempotent — a new login with an old key after a password reset should fail).
- **Store: Postgres**, not in-memory. Single table `IdempotencyKey { key, user_id, response_json, created_at, expires_at }` with `@@unique([key, user_id])`. TTL 24h, cleaned by nightly cron. Pinning single-instance deploy is **not** relied upon.
- **Rate limit:** 5 punch attempts per minute per user. Token bucket stored in Postgres (`RateLimitBucket { user_id, scope, tokens, refilled_at }`) — same reason, survives restart and horizontal scale. Login rate limit: 5/min per username+IP.

### 4.3 Append-only audit log

`audit_log` is INSERT-only. DB-level `REVOKE UPDATE, DELETE ON audit_log FROM ems_app`. Every admin mutation (user create/edit, punch correction, advance decision, adjustment, schedule override) writes one row.

### 4.4 Soft-disable users

`User.is_active=false` — payroll history preserved. Admin re-enables; never deletes. **`archived_at` removed** (single source of truth: `is_active`).

### 4.5 Rate history pattern (decision #19)

`payout` resolves the right rate per punch by joining `punch.user_id` → `rate_change` at `punch.time`. Past punches locked to rate-at-time. Future punches use new rate. Ledger is immutable.

### 4.6 Schedule override + leave request (decision #15)

`ScheduleOverride` is the **schedule layer's materialized truth** (admin grid joins it). `LeaveRequest` is the **employee-facing request** that, on approval, writes a `ScheduleOverride{source: EMPLOYEE_REQUEST}`. Both exist. Ship together or not at all.

### 4.7 Authorization model

| Endpoint group | employee | driver | admin |
|---|---|---|---|
| `/api/auth/*` | ✅ | ✅ | ✅ |
| `/api/me/punch` | ✅ (own) | ✅ (own) | ❌ |
| `/api/admin/punches/correct` | ❌ | ❌ | ✅ audit-logged |
| `/api/me/trip/*` | ❌ | ✅ | ❌ |
| `/api/me/advances` | ✅ own | ✅ own | read all |
| `/api/me/leave` | ✅ own | ✅ own | read all |
| `/api/admin/**` | ❌ | ❌ | ✅ |

Server-side per route. PWA hides buttons = UX; the server is the gate.

### 4.8 Error model

All API responses: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

Stable error codes:
- `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT`
- `OUT_OF_GEOFENCE`, `LOW_GPS_ACCURACY`
- `ALREADY_PUNCHED_IN`, `OPEN_TRIP_EXISTS`
- `DAY_OFF_PUNCH_BLOCKED`
- `EXCEEDS_ACCRUED_EARNINGS`
- `RATE_LIMITED`, `IDEMPOTENT_REPLAY`

Zod errors collapse into `INVALID_INPUT` with flattened field details.

---

## 5. Timezone (decision #31) — the Lebanon rule

**The single most-bug-prone integration in this system.** Getting it wrong makes every flag fire an hour off twice a year.

**Rule:** All timestamps in the database are **UTC**. All schedule times in the DB are **local wall-clock** (e.g. `09:00`, no timezone offset stored — they're just "9am"). All comparisons happen in **Asia/Beirut**.

**Library:** `date-fns-tz` (lightweight, DST-aware, no moment.js bloat). **Pin to `date-fns-tz@^2.0.0`** in `package.json` (issue #5 — v3 renamed `zonedTimeToUtc` → `fromZonedTime` and `utcToZonedTime` → `toZonedTime`; using v2 API as written below).

**Implementation pattern (`lib/time.ts`):**
```ts
import { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } from 'date-fns-tz';  // v2.x

export const SHOP_TZ = 'Asia/Beirut';

// Convert a UTC Date to "wall-clock parts in Beirut" for schedule lookup
export function inBeirut(d: Date): { date: string /* YYYY-MM-DD */, hhmm: string /* HH:MM */ } { ... }

// Today's date in Beirut (used for "today's punches", "today's schedule")
export function todayInBeirut(now: Date = new Date()): string { ... }

// Convert "scheduled start at today 09:00 Beirut" → UTC Date for cron comparison
export function scheduledToUtc(date: string, hhmm: string): Date {
  return zonedTimeToUtc(`${date} ${hhmm}`, SHOP_TZ);
}
```

**Where it matters:**
- **Cron comparisons:** "schedule_start + 30 min" is computed by converting `Schedule.start_time` (local) + `date` → UTC, then comparing to `now` (UTC).
- **Day boundaries:** "today" = Beirut-local date. A punch at 23:30 UTC on a Sunday is still Sunday in Beirut (UTC+2 in winter, UTC+3 in summer). Without this, late-night punches get filed under the wrong day.
- **DST transitions:** Lebanon switches DST by government decree, sometimes with late announcements. `date-fns-tz` uses IANA TZDB which is kept current by the OS. The Hetzner VPS must run `tzdata-update` regularly (covered in RUNBOOK).

**Open item:** Confirm whether Lebanon is currently observing DST or has suspended it (it has been inconsistent since 2023). Field test will reveal; the library handles whatever the OS says.

---

## 6. Final Data Model (Prisma) — AUTHORITATIVE

```prisma
// Single source of truth. If it disagrees with §15 of an older draft, this wins.

model User {
  id                   String   @id @default(cuid())
  username             String   @unique
  password_hash        String   // bcrypt(password, 12)
  role                 Role     // EMPLOYEE | DRIVER | ADMIN
  branch_id            String?  // null for ADMIN (admins are global)
  branch               Branch?  @relation(fields: [branch_id], references: [id])
  hourly_rate_cent     Int      // USD cents (decision #35); denormalized mirror of latest RateChange.rate_cent
  is_active            Boolean  @default(true)
  telegram_chat_id     String?  // bot writes on /start
  // Notification prefs (decision #16, admin rows only):
  notify_daily_summary Boolean  @default(true)
  notify_routine_pings Boolean  @default(true)
  created_at           DateTime @default(now())
  // archived_at removed — use is_active=false
  // Back-relations (issue #4 — every relation declares both sides):
  punches              Punch[]
  rate_changes         RateChange[]
  schedules            Schedule[]
  schedule_overrides   ScheduleOverride[]
  leave_requests       LeaveRequest[]
  trips_as_driver      Trip[]    @relation("TripDriver")
  advances             Advance[]
  adjustments          Adjustment[]
  flags                Flag[]
  @@index([branch_id])
}

enum Role { EMPLOYEE DRIVER ADMIN }

model Branch {
  id                  String  @id @default(cuid())
  name                String
  lat                 Float
  lng                 Float
  gps_radius_m        Int     @default(50)
  gps_accuracy_max_m  Int     @default(100)
  absent_grace_min    Int     @default(15)
  trip_threshold_min  Int     @default(30)
  is_active           Boolean @default(true)        // soft-disable
  users               User[]
  punches             Punch[]
  trips               Trip[]
  flags               Flag[]
}

model Punch {
  id                 String   @id @default(cuid())
  user_id            String
  user               User     @relation(fields: [user_id], references: [id])
  branch_id          String
  branch             Branch   @relation(fields: [branch_id], references: [id])
  kind               PunchKind  // IN | OUT
  at                 DateTime   // UTC
  lat                Float
  lng                Float
  accuracy_m         Int
  device_fp          String
  ip                 String
  // Corrections are written as new audit entries, never as UPDATE:
  corrected          Boolean  @default(false)
  corrected_by       String?
  correction_reason  String?
  created_at         DateTime @default(now())
  @@index([user_id, at])
  @@index([branch_id, at])
}

enum PunchKind { IN OUT }

model RateChange {
  id              String   @id @default(cuid())
  user_id         String
  user            User     @relation(fields: [user_id], references: [id])
  rate_cent       Int      // USD cents
  effective_from  DateTime // UTC
  created_at      DateTime @default(now())
  @@index([user_id, effective_from])
}

model Schedule {
  id        String @id @default(cuid())
  user_id   String
  user      User   @relation(fields: [user_id], references: [id])
  weekday   Int    // 0 = Sunday ... 6 = Saturday (matches JS Date.getDay())
  start_time String  // "HH:MM" wall-clock, Asia/Beirut; CHECK regex '^\d{2}:\d{2}$'
  end_time   String  // "HH:MM" wall-clock, Asia/Beirut; CHECK regex '^\d{2}:\d{2}$'
  @@unique([user_id, weekday])
  // Raw SQL CHECK in migration:
  //   ALTER TABLE "Schedule" ADD CONSTRAINT schedule_weekday_chk CHECK (weekday BETWEEN 0 AND 6);
  //   ALTER TABLE "Schedule" ADD CONSTRAINT schedule_time_chk CHECK (start_time ~ '^\d{2}:\d{2}$' AND end_time ~ '^\d{2}:\d{2}$');
}

model ScheduleOverride {
  id          String   @id @default(cuid())
  user_id     String
  user        User     @relation(fields: [user_id], references: [id])
  date        DateTime @db.Date  // YYYY-MM-DD in Asia/Beirut
  kind        OverrideKind
  start_time  String?
  end_time    String?
  note        String?
  source      OverrideSource
  created_at  DateTime @default(now())
  @@unique([user_id, date])
}

enum OverrideKind { DAY_OFF TIME_CHANGE }
enum OverrideSource { ADMIN_DIRECT EMPLOYEE_REQUEST EMPLOYEE_DAY_OFF }

model LeaveRequest {
  id           String   @id @default(cuid())
  user_id      String
  user         User     @relation(fields: [user_id], references: [id])
  kind         OverrideKind
  start_date   DateTime @db.Date
  end_date     DateTime @db.Date
  start_time   String?
  end_time     String?
  note         String?
  status       RequestStatus
  decided_by   String?
  decided_at   DateTime?
  created_at   DateTime @default(now())
  @@index([user_id, status])
  // Raw SQL CHECK in migration:
  //   ALTER TABLE "LeaveRequest" ADD CONSTRAINT leave_range_chk CHECK (end_date >= start_date);
}

enum RequestStatus { PENDING APPROVED REJECTED }

model Trip {
  id                   String   @id @default(cuid())
  driver_id            String
  driver               User     @relation("TripDriver", fields: [driver_id], references: [id])
  branch_id            String
  branch               Branch   @relation(fields: [branch_id], references: [id])
  out_at               DateTime
  out_lat              Float
  out_lng              Float
  back_at              DateTime?
  back_lat             Float?
  back_lng             Float?
  over_threshold       Boolean  @default(false)
  threshold_alerted_at DateTime?
  @@index([driver_id, out_at])
  // Raw SQL in migration:
  //   CREATE UNIQUE INDEX trip_one_open ON "Trip"(driver_id) WHERE back_at IS NULL;
  //   CREATE INDEX trip_open_by_branch ON "Trip"(branch_id) WHERE back_at IS NULL;  -- supports /api/admin/now
}

model Advance {
  id          String   @id @default(cuid())
  user_id     String
  user        User     @relation(fields: [user_id], references: [id])
  amount_cent Int      // USD cents
  reason      String?
  status      RequestStatus  // PENDING | APPROVED | REJECTED  (NO "PAID" — decision #20)
  decided_by  String?
  decided_at  DateTime?
  created_at  DateTime @default(now())
  @@index([user_id, status])
}

model Adjustment {
  id          String   @id @default(cuid())
  user_id     String
  user        User     @relation(fields: [user_id], references: [id])
  period      DateTime @db.Date  // always the 1st of the month, Asia/Beirut
  kind        AdjustmentKind
  amount_cent Int      // always non-negative; sign comes from kind (BONUS=+, DEDUCTION=-)
  reason      String
  created_by  String
  created_at  DateTime @default(now())
  @@index([user_id, period])
  // Raw SQL CHECK in migration:
  //   ALTER TABLE "Adjustment" ADD CONSTRAINT adjustment_amount_chk CHECK (amount_cent >= 0);
  //   ALTER TABLE "Adjustment" ADD CONSTRAINT adjustment_period_chk CHECK (EXTRACT(DAY FROM period) = 1);
}

enum AdjustmentKind { BONUS DEDUCTION }

model Flag {
  id          String   @id @default(cuid())
  kind        FlagKind  // WATCHED | MISSED_CHECKOUT | TRIP_OVER_THRESHOLD
  user_id     String?
  user        User?    @relation(fields: [user_id], references: [id])
  branch_id   String?
  branch      Branch?  @relation(fields: [branch_id], references: [id])
  context_json Json
  created_at  DateTime @default(now())
  notified_at DateTime?
  @@index([created_at(sort: Desc)])
}

enum FlagKind { WATCHED MISSED_CHECKOUT TRIP_OVER_THRESHOLD }

model AuditLog {
  id           String   @id @default(cuid())
  actor_id     String
  action       String   // "user.create", "punch.correct", "advance.approve", ...
  entity       String
  entity_id    String
  before_json  Json?
  after_json   Json?
  at           DateTime @default(now())
  @@index([entity, entity_id])
  // REVOKE UPDATE, DELETE ON audit_log FROM ems_app;  (applied in migration)
}

model IdempotencyKey {
  key          String
  user_id      String
  response_json Json
  status_code  Int
  created_at   DateTime @default(now())
  expires_at   DateTime
  @@id([key, user_id])     // composite PK
  @@index([expires_at])    // nightly cleanup
}

model RateLimitBucket {
  identifier  String   // "user:{user_id}:punch" | "login:{username}:{ip}" | etc.
  tokens      Int
  refilled_at DateTime @default(now())
  @@id([identifier])
}
```

**Append-only guarantee:** No UPDATE statements in services for `Punch`, `RateChange`, `Adjustment`, `AuditLog`. Corrections are INSERTs into `AuditLog` referencing the entity. **`Flag`** has exactly one permitted UPDATE: setting `notified_at` once when the WATCHED flag is resolved (§8.5). Original `kind`, `context_json`, `created_at` are never altered.

**Currency:** All `*_cent` fields are **USD cents** (decision #35). Single-currency v1. No FX.

---

## 7. Endpoints

### 7.1 Auth
- `POST /api/auth/login` `{ username, password }` → sets cookies.
- `POST /api/auth/logout`
- `POST /api/auth/refresh`

### 7.2 Employee
- `POST /api/me/punch` `{ kind: 'IN'|'OUT', lat, lng, accuracy, deviceFp }`
- `GET /api/me/today` → `{ in_at?, minutes_since_in?, earned_today_cent, earned_month_cent, approved_advance_balance_cent, net_cent }` (recomputed from punches + rate_changes on each request)
- `GET /api/me/advances` → `{ pending: number, approved_balance_cent: number }` (no history — decision §3.3 #8)
- `POST /api/me/advances` `{ amountCent, reason? }`
- `GET /api/me/leave` → `{ pending: number, upcoming: ScheduleOverride[] }`
- `POST /api/me/leave` `{ kind, start_date, end_date, start_time?, end_time?, note? }`
- `GET /api/me/payroll?month=YYYY-MM` → own numbers only

### 7.3 Driver (inherits employee)
- `POST /api/me/trip/start` `{ lat, lng, accuracy }`
- `POST /api/me/trip/end` `{ lat, lng, accuracy }`
- `GET /api/me/trip/current` → banner data (`{ open: boolean, since_min: number, threshold_min: number }`). **Client polls every 30s** to preserve battery; `since_min` is server-computed for accuracy.

### 7.4 Admin
- `GET /api/admin/now` → presence + open trips + today's flags (one query, decision #17)
- `GET /api/admin/pending` → advances awaiting decision
- `POST /api/admin/advances/:id/decision` `{ decision: 'APPROVED'|'REJECTED' }`
- `GET /api/admin/payroll?month=YYYY-MM` → full table (month-picker only, decision #24)
- `POST /api/admin/punches/correct` `{ punchId, newAt?, newBranchId?, reason }` (audit-logged)
- `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/deactivate`, `POST /api/admin/users/:id/reset-password` → returns `{ temp_password }` (admin shares verbally with employee)
- `GET /api/admin/branches`, `POST /api/admin/branches`, `PATCH /api/admin/branches/:id`
- `GET /api/admin/schedules/:userId`, `PUT /api/admin/schedules/:userId`
- `GET /api/admin/leave` (across all users, for admin inbox if needed)
- `POST /api/admin/leave/:id/decision` `{ decision: 'APPROVED'|'REJECTED' }`
- `POST /api/admin/adjustments` `{ userId, kind: 'BONUS'|'DEDUCTION', amountCent, reason }`
- `PATCH /api/admin/users/:id/notification-prefs` `{ dailySummary?, routinePings? }` — **two booleans only**, decision #16
- `GET /api/admin/reports/payroll?month=YYYY-MM` → PDF stream (GET, not POST — read-only)

### 7.5 System
- `POST /api/telegram/webhook` — receives `/start` from bot, no callbacks
- `GET /api/health`, `GET /api/health/db`

---

## 8. Services & Rules

### 8.1 Auth service (`lib/auth/session.ts`)

Implements decisions #13, #34, #36:
```ts
export function sessionExpiryFor(user: User, now: Date): Date {
  if (user.role === 'DRIVER') {
    // Decision #36: find schedule whose start_time falls in the past 24h (handles cross-midnight shifts)
    const recentSchedule = findScheduleInPast24h(user.id, now);
    if (recentSchedule) {
      const scheduleDate = todayInBeirut(recentSchedule.start_time);
      const endUtc = scheduledToUtc(scheduleDate, recentSchedule.end_time);
      // If endUtc is in the past (overnight shift started yesterday, ended today),
      // use the schedule that started yesterday and add 24h.
      return addMinutes(maxOf(endUtc, now), 30);
    }
    // Decision #34 fallback: no recent schedule → employee rule
    return addMinutes(now, 2 * 60);
  }
  // Employee: 2h after last API activity
  return addMinutes(now, 2 * 60);
}
```

### 8.2 Geofence (`lib/geofence.ts`)

Pure function. See §3.5. Returns `{ ok, nearest?, distance?, reason? }`.

### 8.3 Payout (`lib/services/payout.ts`)

Pure function. Inputs: `punches[]`, `rateChanges[]`, `adjustments[]`, `approvedAdvances[]`, `month`. Output: `{ hours, grossCent, adjustmentsCent, advancesCent, netCent }`.

```ts
function payoutForUser(userId: string, month: string, db: PrismaClient) {
  const punches = await db.punch.findMany({
    where: { user_id: userId, at: { gte: monthStartUtc, lt: monthEndUtc } },
    orderBy: { at: 'asc' },
  });
  // Pair IN/OUT, compute minutes per pair, multiply by rate-at-that-time
  // Sum adjustments, subtract approved advances
  return { hours, grossCent, adjustmentsCent, advancesCent, netCent };
}
```

Decision #19: rate resolved per-punch from `RateChange` at `punch.at`.

**Single source of truth for rate (issue #3):** `RateChange` is the *only* table payout reads from. `User.hourly_rate_cent` is a **denormalized display convenience** that mirrors the most-recent `RateChange.rate_cent` for that user. Rules:
- **User creation** MUST write a `RateChange { user_id, rate_cent: <initial>, effective_from: <now> }` row in the same transaction as the `User` insert. No bare `User` insert.
- **Admin edits rate** (`PATCH /api/admin/users/:id` with new `hourlyRateCent`) MUST write a new `RateChange` row with `effective_from = <now>`. Past punches are locked to their original rate.
- Payout service NEVER reads `User.hourly_rate_cent`. Reading only `RateChange` is the invariant.

**Performance (issue #4):** at 3 branches × ~30 employees, this runs in <200ms on demand. The admin payroll screen does NOT cache — every load recomputes. If field test shows latency, add a `PayoutSnapshot { user_id, period, hours, gross_cent, adjustments_cent, advances_cent, net_cent, computed_at }` table written by a nightly cron (00:30 Asia/Beirut) and read by the payroll endpoint. Trivial to retrofit; not in v1 unless load testing proves it's needed.

### 8.4 Punch handler (`lib/services/punch.ts`)

Order of guards:
1. **Day-off guard** (decision #12): `if (userHasApprovedDayOffToday(user, now)) throw DAY_OFF_PUNCH_BLOCKED`.
2. **Open trip guard** (drivers only): `if (user.role === 'DRIVER' && openTrip) throw OPEN_TRIP_EXISTS`.
3. **Geofence gate** (decision §3.1): `verifyWithinGeofence(...)`.
4. **State machine:** reject if user already has open IN when kind=IN, reject if no open IN when kind=OUT.
5. **Insert punch.**
6. **Resolve WATCHED flag inline** (decision #33 — see §8.5).
7. **Audit log entry** for the punch (no UPDATE; if this is a correction, the calling admin handler does that separately).
8. **Return updated counters** (live minutes since IN, earned today, etc.).

### 8.5 WATCHED flag resolution (decision #33)

**Action-based, fires inline in the punch handler. NOT a cron.** Decision #10 says action-based events fire in the handler; cron-polling for "did a watched user punch since last tick" is a race condition wearing a schedule.

**Race-safe resolution (issues #2, #7):** select the specific WATCHED flag first, then claim it by `id` with the `notified_at IS NULL` guard. Two-step is needed because (a) we need the flag row to render the Telegram message, and (b) the claim must be atomic against concurrent punches. The `findFirst + updateMany` with the `notified_at IS NULL` predicate guarantees exactly one claimer:

```ts
// Inside punch.ts after a successful punch insert:
// Step 1: select the oldest unresolved WATCHED flag for this user (one row, deterministic).
const candidate = await db.flag.findFirst({
  where: { kind: 'WATCHED', user_id: user.id, notified_at: null },
  orderBy: { created_at: 'asc' },
});
if (candidate) {
  // Step 2: claim it atomically. Only the punch whose updateMany touches 1 row wins the race.
  const claim = await db.flag.updateMany({
    where: { id: candidate.id, notified_at: null },
    data: { notified_at: new Date() },
  });
  if (claim.count === 1) {
    await notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'watched.resolved',
      context: { user, punch, watched: candidate },
    });
  }
  // claim.count === 0 means a concurrent punch already claimed this flag; silent skip.
}
```

**Unresolved WATCHED flags (issue #3):** if the user never punches at all that day, the flag stays with `notified_at=null` forever. The end-of-day cron (§3.9) surfaces these to the admin dashboard "Unresolved absences today" panel and also sends one Telegram per unresolved flag at 23:30 Asia/Beirut: "Employee X never punched in today (watched since 09:30, no resolution)." Dedup per flag row.

**Watcher cron (§3.9)** writes the WATCHED flag row, **does not notify**. Notification happens at the moment of resolution OR at end of day, whichever comes first. One message per incident.

### 8.6 Missed-checkout detection (decision #32)

**The ambiguity:** "Employee still clocked in 30 min past schedule end" can mean overtime OR forgot to punch out. The system can't tell. The text says so.

**Cron (`*/1 * * * *`)** — fires at **schedule_end + 30 min + 5 min buffer = 35 min past schedule end** (decision #32 wording: "30 min past schedule end"; implementation: +5 min buffer to avoid a 1-minute false-positive window where the cron ticks at 14:30:59 while the employee punches out at 14:30:30). The system **does not** try to distinguish overtime from forgotten punch-out — it can't, and the spec's neutral wording acknowledges that. Single check:

```ts
// For each user whose schedule ended ≥ 35 min ago AND who still has an open IN punch
// (i.e., no OUT punch after the last IN):
//   Telegram ONE TIME per shift:
//     "Employee Y, Branch B is still clocked in 35 min past shift end
//      (8h 50m into shift). Overtime, or forgot to punch out?"
//   Dedup via Flag row with same kind + user + shift_date.
```

The message is **neutral by design**. Admin reads, disambiguates, edits the punch manually if needed.

### 8.7 Notifier (`lib/notify/index.ts`)

```ts
export const notifier: Notifier = process.env.NODE_ENV === 'production'
  ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.PUBLIC_APP_URL)
  : new ConsoleNotifier();
```

Templates in `lib/notify/templates/` — pure functions returning `{ text, parseMode, deepLink? }`.

### 8.8 Notification prefs (decision #16)

Two booleans on `User` (admin rows only — only the admin has a Telegram chat_id in v1):
- `notify_daily_summary` (default true) — 23:00 Asia/Beirut daily closing summary.
- `notify_routine_pings` (default true) — fires when an employee punches IN on time (within `branch.absent_grace_min` of schedule_start, no WATCHED flag). Suppresses the routine on-time ping; exceptions (late, missed, watched-resolution, trip-over-threshold) always fire.

**Exception events always fire.** No off switch. Implemented in `lib/notify/send.ts`:
```ts
if (event.kind === 'EXCEPTION') return dispatch(payload);  // always
if (event.kind === 'DAILY_SUMMARY' && !user.notify_daily_summary) return;  // skip
if (event.kind === 'ROUTINE_PING' && !user.notify_routine_pings) return;  // skip
```

---

## 9. Security

- **Cookies:** `Secure; HttpOnly; SameSite=Lax; Path=/`.
- **Passwords:** `bcrypt(password, 12)` — 12 rounds (≈250ms on modern hardware). Never stored plaintext.
- **CSRF:** Double-submit cookie pattern. On login, server sets a non-httpOnly `csrf` cookie (random 32 bytes, base64). Client JS reads it and echoes it in `X-CSRF-Token` header on every state-changing request. Server compares cookie === header. Reject on mismatch. Exempt: `/api/auth/login` (no cookie yet) and webhook (`/api/telegram/webhook`, uses Telegram's secret token instead).
- **Rate limiting:** stored in Postgres `RateLimitBucket` table (issue #1, #12). Identifier format:
  - Punch: `user:{user_id}:punch` → 5/min per user.
  - Login: `login:{username}:{ip}` → 5/min per username+IP. Login rate-limit works even when the username doesn't exist (no `user_id` available pre-auth).
- Token bucket: refill 5 tokens/min. Each request consumes 1; reject with `RATE_LIMITED` when empty.
- **Idempotency:** stored in Postgres `IdempotencyKey` table (issue #1).
- **Postgres:** never on public internet. Only `web` and `worker` containers can reach it.
- **Secrets:** Coolify-managed env vars. `.env.example` in repo, real `.env` never committed.
- **CSP:** strict, no inline scripts. `frame-ancestors 'none'`.
- **Geofence:** reject before DB write if accuracy exceeds threshold.
- **Telegram webhook:** require `X-Telegram-Bot-Api-Secret-Token` to match.
- **Audit log:** Postgres `REVOKE UPDATE, DELETE ON audit_log FROM ems_app`.
- **Backups at rest:** gpg key mounted via Coolify secret at `/run/secrets/backup.key`. Container runs as non-root user; `/run/secrets` is mode 0400 owned by the backup user.
- **Refresh token cap (issue #31):** refresh token max-age = `min(7d, driverSessionEnd - now)` where `driverSessionEnd` is `schedule_end + 30 min` in Asia/Beirut (decision #13). For employees, 7d. For drivers on cross-midnight shifts, see §13.1 decision #36.

---

## 10. Build Order & Timeline

### 10.1 Why "one month build + one month test" is honest

The PRD says ~1 month build + up to 1 month testing + 1 day rollout. The 6-week build below **bleeds into the testing month by design**: weeks 5–6 produce an alpha we test on, not a polished v1. This is normal and not slippage. When talking to the client, frame it that way.

### 10.2 Build phases (6 weeks)

| Week | Deliverable |
|---|---|
| **1** | Monorepo scaffold (pnpm). `apps/web` (Next.js 14, Tailwind), `apps/worker` (Node + node-cron), `packages/db` (Prisma). Docker compose: `web`, `worker`, `db`. Auth: login/logout, JWT cookie, bcrypt (12 rounds), role guard middleware. Prisma initial migration per §6 (incl. raw-SQL partial indexes + CHECKs + REVOKE). CI (GitHub Actions: lint + typecheck + vitest). Seed (1 admin `owner/change-me` to be changed on first login, 3 branches with real Beirut coords, 1 sample employee per branch). |
| **2** | Branch + User admin CRUD (create, deactivate, edit, role, rate). Punch endpoints with server-side haversine + accuracy rules + day-off guard + open-trip guard. Employee PWA: login, home, big check-in/out button, day-off-aware UI. `/api/admin/now` endpoint (one query). |
| **3** | Rate-history-driven payout (pure function, fully unit-tested). Advance request flow (employee side) + admin decision endpoint (dashboard only). Live earnings panel. Adjustment (top-up) admin endpoint. Audit log on every mutation. Idempotency + rate limit middleware. |
| **4** | Driver trip start/end (geofence-gated both ways). Trip-threshold cron. `LeaveRequest` table + employee request screen + admin schedule grid editor with inline pending requests + flag suppression. Watched-flag cron + missed-checkout cron. WATCHED resolution inline in punch handler (decision #33). |
| **5** | Punch correction (audit-logged). Branch form (radius, accuracy max, trip threshold, absent grace, pin). Notification prefs UI (2 toggles on user row). Telegram bot: `/start` chat-binding, alert sender, daily summary template. Timezone library wiring (`lib/time.ts`, decision #31). |
| **6** | Payroll PDF (single template). PWA install (manifest + minimal service worker). Sentry + structured logs + health endpoints + UptimeRobot. Backup script + restore drill on staging. Polish. **Alpha ready for pilot.** |

### 10.3 Field testing & rollout

| Phase | Duration | Owner |
|---|---|---|
| Developer on-site at 1 branch | week 7 | Kyvera (~3 days on-site) |
| Quiet field test with selected staff | week 7–8 | Owner + selected staff |
| Live pilot at 1 branch | week 8 | Full branch |
| Bug-fix window (no new features) | week 8 | Kyvera on-call |
| Rollout to branches 2 & 3 | end week 8 / day 1 week 9 | Kyvera (1 day) |

**Pilot exit rule:** no payroll-affecting bugs → full rollout.

### 10.4 Total realistic timeline

| Path | Build | Test + Pilot | Rollout | Total |
|---|---|---|---|---|
| Realistic | 6 weeks | 2 weeks | 1 day | **~8 weeks** |
| Optimistic | 6 weeks | 1 week | 1 day | **~7 weeks** |
| Pessimistic | 6 weeks | 3 weeks | 1 day | **~10 weeks** |

### 10.5 Post-launch (deferred, not in v1)

| Item | Why deferred |
|---|---|
| 3 remaining PDF templates | Architecture in place, layouts are quotable |
| Telegram bot smart-pass | Needs real data — design after deployment |
| Arbitrary date-range filter | Edge-case hell; month-picker enough |
| WhatsApp | Behind `Notifier` interface when asked |
| Multi-admin / manager roles | PRD §12 |
| Self-serve password reset | Admin-driven only |
| Native iOS/Android | PWA covers it |

---

## 11. Repository Layout

```
/
  apps/
    web/                     # Next.js 14
      app/                   # App Router pages + route handlers
      components/
      lib/                   # services, geofence, notify, pdf, time
      public/                # manifest, sw, icons
      middleware.ts
    worker/                  # node-cron jobs + notifier (outbound only)
      src/jobs/*.cron.ts
      src/index.ts
  packages/
    db/                      # Prisma schema + generated client (shared)
    notify/                  # Notifier interface + Console + Telegram impls
    pdf/                     # React-PDF templates (payroll only in v1)
  scripts/
    backup.sh
    restore.sh
  docker-compose.yml         # web, worker, postgres
  Dockerfile.web
  Dockerfile.worker
  .env.example
  RUNBOOK.md
  AGENTS.md
```

pnpm workspaces. One repo, one CI, one deploy.

---

## 12. Local Dev Quickstart

```bash
docker compose up -d db
pnpm install
pnpm --filter db prisma migrate dev
pnpm --filter web dev          # http://localhost:3000  (Notifer: ConsoleNotifier)
pnpm --filter worker dev       # cron runner (logs to stdout)
pnpm test                      # vitest
pnpm e2e                       # playwright mobile
```

Seed: admin `owner / change-me` (must be changed on first login), 3 branches with **real Beirut coords** (Hamra 33.8962°N 35.4827°E, Achrafieh 33.8895°N 35.5163°E, Verdun 33.8912°N 35.4871°E — placeholders, admin edits via Branch form before going live), 1 sample employee per branch with weekly schedule (09:00–18:00 Sat–Thu) and $2/hr rate (200 cents).

---

## 13. Decisions Log (36, locked)

### Stack picks
1. Soketi over Pusher SaaS — *cut by #17*. Stack has no real-time infra.
2. `@react-pdf/renderer` over Puppeteer — no Chromium in prod.
3. `node-cron` worker over OS cron — version-controlled, restartable.
4. Worker in same stack as web — single Coolify dashboard.
5. Vitest + Playwright over Jest — faster, Next-aligned.
6. Append-only audit log enforced at DB role level.
7. Payout calc is a pure function — easy to test, no web coupling.
8. Geofence is a pure function — same reason.
9. Server-side validation of every GPS pill — never trust client.

### Architecture
10. **Cron for time-based events, direct call for action-based events.** No event bus.
11. **Telegram = read-only.** No inline buttons. No callback queries. Owner decides in dashboard.
12. Day-off disables punch (server-side guard).
13. Session expiry by role — Employee 2h idle, Driver schedule_end + 30 min.
14. Idempotency-Key + 5/min rate limit replace device fingerprinting.

### Product
15. Schedule grid + leave requests ship together. Approved leave suppresses absent/late flags.
16. **Notifications: two toggles, exceptions always fire.** Stored on `User` row.
17. `/api/admin/now` is a single endpoint. 10s polling, no real-time infra.
18. Stores are 24/7. No auto-close. Missed checkout = notify + manual edit.
19. Rate history table required. Past punches locked to rate-at-time.
20. No "PAID" state on advances. Payment is manual.
21. Advances capped at accrued earnings this month. Prevents debt spiral.
22. New-device fingerprinting cut. Phones break, employees borrow.
23. No CSV export. PDFs only (PRD §6.3 tamper reason).
24. Payroll date-range filter = month-picker only.
25. Single WATCHED flag replaces late + absent + missed-checkout standalone flags.
26. Schedule editor shows leave requests inline. No separate inbox.
27. No overtime flag. Worked-hours in dashboard, no Telegram alert.
28. Driver OUT/BACK require geofence at branch both ways.
29. Trip threshold per-branch, default 30 min. Dedup via `threshold_alerted_at`.
30. Orders-per-trip metric cut.

### Audit-pass additions
31. **Timezone.** UTC stored; comparisons in `Asia/Beirut` via `date-fns-tz`. DST handled by the library. Single most-bug-prone integration.
32. **Missed-checkout message wording.** Neutral, not presumptive. "Still clocked in 30 min past shift end — overtime, or forgot to punch out?" (user-facing copy says 30 min; **implementation fires at 35 min** as a 5-min race buffer, see §3.9 + §8.6). One Telegram per shift (dedup).
33. **WATCHED flag resolution is inline, not cron.** Action-based event per decision #10. Cron writes the flag; punch handler notifies at resolution.
34. **Driver session fallback.** If driver has no schedule row for today, fall back to employee 2h-idle rule (decision #13).
35. **Currency = USD cents.** Single-currency v1. All `*_cent` fields are USD cents.
36. **Cross-midnight driver shifts.** Session expiry reads the schedule that started in the past 24h, not "today's" schedule. Falls back to 2h-idle rule if none. Covers 22:00–06:00 shifts.

---

## 14. Open Items (non-blocking)

- [ ] Exact branch coordinates (Google Maps drop-pin) — fillable in admin UI on first launch; **seed uses real Beirut coords (Hamra / Achrafieh / Verdun placeholders) so system works out of the box**
- [ ] `absent_grace_min` per branch (default 15)
- [ ] `trip_threshold_min` per branch (default 30)
- [ ] Telegram bot handle (we create one; needs owner's phone number to register)
- [ ] Cloudflare account + domain
- [ ] Hetzner VPS chosen and provisioned
- [ ] Owner's English-reading confirmation
- [ ] Current Lebanon DST status (library handles whatever the OS says, but flag for field-test attention)
- [ ] Sentry project — Kyvera creates under our org, owner never sees it
- [ ] UptimeRobot monitor — Kyvera creates free tier, alert email = owner's

None of these block the **build**. All are fillable in weeks 5–6 and during field testing.

---

## 15. Out of Scope (v1)

Explicitly NOT in v1, available as future paid additions:
- Payroll payment execution (system calculates; paying is manual)
- POS / inventory integration
- Route / live GPS tracking of any kind
- Native iOS/Android apps (PWA covers)
- Multiple admin accounts / manager roles
- Fingerprint or biometric hardware
- WhatsApp notifications
- Arbitrary date-range filter on payroll
- 3 of 4 PDF reports (payroll only)
- CSV export
- Smart Telegram bot (v1 is a thin alert relay)
- Self-serve password reset
- Overtime flag
- New-device fingerprinting

---

**End of spec. §1–§15 locked. Ready to scaffold.**

**Authoritative sections for build questions:** §6 (data model), §7 (endpoints), §8 (services & rules), §9 (security). All earlier sections describe these; none override them.