# API Contract — Supermarket EMS

**Source of truth:** `spec.md` §6 (schema), §7 (endpoints), §8 (services), §9 (security).
**Status:** Phase 0 complete. No API endpoints yet. This document is **forward-declared** — every endpoint listed here has its final shape locked by `spec.md` §7. Future phases MUST NOT invent new endpoints or change shapes; if a real need appears, update `spec.md` first, then this file.

**Purpose:** Every function, endpoint, variable, table, and column that this system exposes or uses. Builders of Phase 1+ read this BEFORE `spec.md` to know exactly what's already locked. **If a future build prompt tries to introduce something not in this file, that's a red flag — stop and check `spec.md`.**

**Authority hierarchy (canonical):**
- `spec.md` §6/§7/§8/§9 wins for WHAT (schema, endpoints, service logic, security).
- `build.md` wins for WHEN and HOW (phase order, file naming, commit format).
- Anything new not in either doc: STOP, update both first, then proceed.
- See `build.md` §"How to use this document" for the full table.

---

## 1. Tables (Prisma models from `spec.md` §6)

### `User`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `username` | `String @unique` | Login identifier |
| `password_hash` | `String` | bcrypt(password, 12). Never plaintext |
| `role` | `Role` enum | `EMPLOYEE` \| `DRIVER` \| `ADMIN` |
| `branch_id` | `String?` | NULL for ADMIN (admins are global) |
| `branch` | `Branch?` relation | |
| `hourly_rate_cent` | `Int` | USD cents. **Display-only** — payout reads from `RateChange` |
| `is_active` | `Boolean @default(true)` | Soft-disable; never delete |
| `telegram_chat_id` | `String?` | Bot writes on `/start` |
| `notify_daily_summary` | `Boolean @default(true)` | Admin rows only |
| `notify_routine_pings` | `Boolean @default(true)` | Admin rows only |
| `created_at` | `DateTime @default(now())` | |
| **Back-relations** | `punches`, `rate_changes`, `schedules`, `schedule_overrides`, `leave_requests`, `trips_as_driver` (`@relation("TripDriver")`), `advances`, `adjustments`, `flags` | |

### `Branch`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `name` | `String` | |
| `lat` | `Float` | |
| `lng` | `Float` | |
| `gps_radius_m` | `Int @default(50)` | Per-branch configurable |
| `gps_accuracy_max_m` | `Int @default(100)` | |
| `absent_grace_min` | `Int @default(15)` | |
| `trip_threshold_min` | `Int @default(30)` | |
| `is_active` | `Boolean @default(true)` | Soft-disable |
| **Back-relations** | `users`, `punches`, `trips`, `flags` | |

### `Punch` (append-only)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `branch_id` | `String` | FK → Branch (must be user's assigned branch) |
| `kind` | `PunchKind` enum | `IN` \| `OUT` |
| `at` | `DateTime` | UTC |
| `lat` | `Float` | |
| `lng` | `Float` | |
| `accuracy_m` | `Int` | |
| `device_fp` | `String` | |
| `ip` | `String` | |
| `corrected` | `Boolean @default(false)` | |
| `corrected_by` | `String?` | |
| `correction_reason` | `String?` | |
| `created_at` | `DateTime @default(now())` | |
| **Indexes** | `(user_id, at)`, `(branch_id, at)` | |

### `RateChange` (append-only — single source of truth for rate)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User (non-admin only — admin has no RateChange) |
| `rate_cent` | `Int` | USD cents |
| `effective_from` | `DateTime` | UTC |
| `created_at` | `DateTime @default(now())` | |
| **Indexes** | `(user_id, effective_from)` | |
| **Invariant** | Every non-admin user creation writes a RateChange in the same transaction. Every rate edit writes a new RateChange. | |

### `Schedule`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `weekday` | `Int` | 0 = Sun ... 6 = Sat (matches JS Date.getDay()) |
| `start_time` | `String` | "HH:MM" wall-clock Asia/Beirut |
| `end_time` | `String` | "HH:MM" wall-clock Asia/Beirut |
| **Constraints** | `@@unique([user_id, weekday])`, CHECK `weekday BETWEEN 0 AND 6`, CHECK `start_time ~ '^\d{2}:\d{2}$'`, CHECK `end_time ~ '^\d{2}:\d{2}$'` | |

### `ScheduleOverride` (materialized schedule truth)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `date` | `DateTime @db.Date` | YYYY-MM-DD in Asia/Beirut |
| `kind` | `OverrideKind` enum | `DAY_OFF` \| `TIME_CHANGE` |
| `start_time` | `String?` | |
| `end_time` | `String?` | |
| `note` | `String?` | |
| `source` | `OverrideSource` enum | `ADMIN_DIRECT` \| `EMPLOYEE_REQUEST` \| `EMPLOYEE_DAY_OFF` |
| `created_at` | `DateTime @default(now())` | |
| **Constraints** | `@@unique([user_id, date])` | |

### `LeaveRequest` (employee-facing request, writes ScheduleOverride on approval)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `kind` | `OverrideKind` enum | |
| `start_date` | `DateTime @db.Date` | |
| `end_date` | `DateTime @db.Date` | |
| `start_time` | `String?` | |
| `end_time` | `String?` | |
| `note` | `String?` | |
| `status` | `RequestStatus` enum | `PENDING` \| `APPROVED` \| `REJECTED` |
| `decided_by` | `String?` | |
| `decided_at` | `DateTime?` | |
| `created_at` | `DateTime @default(now())` | |
| **Indexes** | `(user_id, status)` | |
| **Constraints** | CHECK `end_date >= start_date` | |

### `Trip`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `driver_id` | `String` | FK → User (`@relation("TripDriver")`) |
| `branch_id` | `String` | FK → Branch |
| `out_at` | `DateTime` | |
| `out_lat` | `Float` | |
| `out_lng` | `Float` | |
| `back_at` | `DateTime?` | NULL while open |
| `back_lat` | `Float?` | |
| `back_lng` | `Float?` | |
| `over_threshold` | `Boolean @default(false)` | |
| `threshold_alerted_at` | `DateTime?` | Dedup: one alert per trip |
| **Indexes** | `(driver_id, out_at)`, partial unique `(driver_id) WHERE back_at IS NULL`, partial index `(branch_id) WHERE back_at IS NULL` | |

### `Advance`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `amount_cent` | `Int` | USD cents |
| `reason` | `String?` | |
| `status` | `RequestStatus` enum | `PENDING` \| `APPROVED` \| `REJECTED` (**no `PAID`**) |
| `decided_by` | `String?` | |
| `decided_at` | `DateTime?` | |
| `created_at` | `DateTime @default(now())` | |
| **Indexes** | `(user_id, status)` | |
| **Constraint** | Cap at accrued earnings this month (decision #21): `approved_balance + new_amount <= accrued_earnings_this_month` | |

### `Adjustment` (append-only)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `user_id` | `String` | FK → User |
| `period` | `DateTime @db.Date` | Always the 1st of the month, Asia/Beirut |
| `kind` | `AdjustmentKind` enum | `BONUS` \| `DEDUCTION` |
| `amount_cent` | `Int` | Non-negative; sign from `kind` (BONUS=+, DEDUCTION=-) |
| `reason` | `String` | |
| `created_by` | `String` | User.id (admin) |
| `created_at` | `DateTime @default(now())` | |
| **Indexes** | `(user_id, period)` | |
| **Constraints** | CHECK `amount_cent >= 0`, CHECK `EXTRACT(DAY FROM period) = 1` | |

### `Flag`
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `kind` | `FlagKind` enum | `WATCHED` \| `MISSED_CHECKOUT` \| `TRIP_OVER_THRESHOLD` |
| `user_id` | `String?` | FK → User (nullable for system flags) |
| `branch_id` | `String?` | FK → Branch |
| `context_json` | `Json` | |
| `created_at` | `DateTime @default(now())` | |
| `notified_at` | `DateTime?` | **One allowed UPDATE**: set on WATCHED resolution |
| **Indexes** | `(created_at DESC)` | |

### `AuditLog` (append-only, REVOKE UPDATE/DELETE)
| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `actor_id` | `String` | User.id of who did it |
| `action` | `String` | e.g. `"user.create"`, `"punch.correct"`, `"advance.approve"` |
| `entity` | `String` | e.g. `"User"`, `"Punch"`, `"Advance"` |
| `entity_id` | `String` | |
| `before_json` | `Json?` | |
| `after_json` | `Json?` | |
| `at` | `DateTime @default(now())` | |
| **Indexes** | `(entity, entity_id)` | |
| **DB-level** | `REVOKE UPDATE, DELETE ON "AuditLog" FROM ems_app` | |

### `IdempotencyKey`
| Field | Type | Notes |
|---|---|---|
| `key` | `String` | From `Idempotency-Key` header |
| `user_id` | `String` | Scoped per user |
| `response_json` | `Json` | Cached response |
| `status_code` | `Int` | |
| `created_at` | `DateTime @default(now())` | |
| `expires_at` | `DateTime` | Created_at + 24h |
| **PK** | `@@id([key, user_id])` | |
| **Indexes** | `(expires_at)` for nightly cleanup | |

### `RateLimitBucket`
| Field | Type | Notes |
|---|---|---|
| `identifier` | `String` | Format: `"user:{user_id}:punch"` or `"login:{username}:{ip}"` |
| `tokens` | `Int` | Token bucket |
| `refilled_at` | `DateTime @default(now())` | |
| **PK** | `@@id([identifier])` | |

---

## 2. Enums

| Enum | Values |
|---|---|
| `Role` | `EMPLOYEE`, `DRIVER`, `ADMIN` |
| `PunchKind` | `IN`, `OUT` |
| `OverrideKind` | `DAY_OFF`, `TIME_CHANGE` |
| `OverrideSource` | `ADMIN_DIRECT`, `EMPLOYEE_REQUEST`, `EMPLOYEE_DAY_OFF` |
| `RequestStatus` | `PENDING`, `APPROVED`, `REJECTED` |
| `AdjustmentKind` | `BONUS`, `DEDUCTION` |
| `FlagKind` | `WATCHED`, `MISSED_CHECKOUT`, `TRIP_OVER_THRESHOLD` |

---

## 3. Endpoints (forward-declared from `spec.md` §7)

Every endpoint returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

### 3.1 Auth (Phase 1)
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` | sets cookies; `{ mustChangePassword?: bool }` | Public |
| POST | `/api/auth/logout` | — | clears cookies | Any |
| POST | `/api/auth/refresh` | — | new access token cookie | Any |

### 3.2 Employee (Phase 2 onwards)
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/me/punch` | `{ kind: 'IN'\|'OUT', lat, lng, accuracy, deviceFp }` | `{ at, kind, minutes_since_in? }` | employee, driver |
| GET | `/api/me/today` | — | `{ in_at?, minutes_since_in?, earned_today_cent, earned_month_cent, approved_advance_balance_cent, net_cent }` | employee, driver |
| GET | `/api/me/advances` | — | `{ pending: number, approved_balance_cent: number }` | employee, driver |
| POST | `/api/me/advances` | `{ amountCent: number, reason?: string }` | `{ id, status: 'PENDING' }` | employee, driver |
| GET | `/api/me/leave` | — | `{ pending: number, upcoming: ScheduleOverride[] }` | employee, driver |
| POST | `/api/me/leave` | `{ kind, start_date, end_date, start_time?, end_time?, note? }` | `{ id, status: 'PENDING' }` | employee, driver |
| GET | `/api/me/payroll?month=YYYY-MM` | — | `{ hours, gross_cent, adjustments_cent, advances_cent, net_cent }` | employee, driver (own only) |

### 3.3 Driver (Phase 4)
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/me/trip/start` | `{ lat, lng, accuracy }` | `{ trip_id, out_at }` | driver only |
| POST | `/api/me/trip/end` | `{ lat, lng, accuracy }` | `{ trip_id, back_at, duration_min }` | driver only |
| GET | `/api/me/trip/current` | — | `{ open: boolean, since_min?: number, threshold_min: number }` | driver only |

### 3.4 Admin (Phase 5a)
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| GET | `/api/admin/now` | — | `{ branches: [{ id, name, present: User[], absent: User[], driversOut: Trip[] }], flags: Flag[] }` | admin |
| GET | `/api/admin/pending` | — | `{ advances: Advance[] }` | admin |
| POST | `/api/admin/advances/:id/decision` | `{ decision: 'APPROVED'\|'REJECTED' }` | `{ id, status }` | admin |
| GET | `/api/admin/payroll?month=YYYY-MM` | — | `{ rows: [...], totals: {...} }` | admin |
| POST | `/api/admin/punches/correct` | `{ punchId, newAt?, newBranchId?, reason }` | `{ punch: Punch }` | admin (audit-logged) |
| GET | `/api/admin/users` | — | `{ users: User[] }` | admin |
| POST | `/api/admin/users` | `{ username, password, role, branchId?, hourlyRateCent }` | `{ user, temp_password }` | admin |
| PATCH | `/api/admin/users/:id` | `{ hourlyRateCent?, role?, branchId? }` | `{ user }` | admin (audit-logged) |
| POST | `/api/admin/users/:id/deactivate` | — | `{ user }` | admin |
| POST | `/api/admin/users/:id/reset-password` | — | `{ temp_password }` | admin |
| GET | `/api/admin/branches` | — | `{ branches: Branch[] }` | admin |
| POST | `/api/admin/branches` | `{ name, lat, lng, gps_radius_m?, gps_accuracy_max_m?, absent_grace_min?, trip_threshold_min? }` | `{ branch }` | admin |
| PATCH | `/api/admin/branches/:id` | `{ ... partial }` | `{ branch }` | admin |
| GET | `/api/admin/schedules/:userId` | — | `{ schedule: Schedule[], overrides: ScheduleOverride[] }` | admin |
| PUT | `/api/admin/schedules/:userId` | `{ schedule: [{ weekday, start_time, end_time }] }` | `{ schedule }` | admin |
| GET | `/api/admin/leave` | — | `{ requests: LeaveRequest[] }` | admin |
| POST | `/api/admin/leave/:id/decision` | `{ decision: 'APPROVED'\|'REJECTED' }` | `{ request, override? }` | admin |
| POST | `/api/admin/adjustments` | `{ userId, kind: 'BONUS'\|'DEDUCTION', amountCent: number, reason: string }` | `{ adjustment }` | admin (audit-logged) |
| PATCH | `/api/admin/users/:id/notification-prefs` | `{ dailySummary?: bool, routinePings?: bool }` | `{ user }` | admin |
| GET | `/api/admin/reports/payroll?month=YYYY-MM` | — | PDF stream (`Content-Type: application/pdf`) | admin |

### 3.5 System (Phase 5b + Phase 6)
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/telegram/webhook` | Telegram update | 200 | Telegram secret token |
| GET | `/api/health` | — | `{ ok: true }` | Public |
| GET | `/api/health/db` | — | `{ ok: true, latency_ms }` or 503 | Public |

---

## 4. Stable error codes (`spec.md` §4.8)

`UNAUTHORIZED` · `FORBIDDEN` · `INVALID_INPUT` · `OUT_OF_GEOFENCE` · `LOW_GPS_ACCURACY` · `ALREADY_PUNCHED_IN` · `OPEN_TRIP_EXISTS` · `DAY_OFF_PUNCH_BLOCKED` · `EXCEEDS_ACCRUED_EARNINGS` · `RATE_LIMITED` · `IDEMPOTENT_REPLAY`

---

## 5. Pure functions (`spec.md` §3.5, §5, §8.3)

| Function | Module | Signature | Phase |
|---|---|---|---|
| `verifyWithinGeofence` | `apps/web/lib/geofence.ts` | `(lat, lng, branches, accuracy) => { ok, nearest?, distance?, reason?: 'TOO_FAR'\|'LOW_GPS_ACCURACY' }` | 2.5 |
| `todayInBeirut` | `packages/time/src/index.ts` | `(now?: Date) => string /* YYYY-MM-DD */` | 2.5 |
| `inBeirut` | `packages/time/src/index.ts` | `(d: Date) => { date: string, hhmm: string }` | 2.5 |
| `scheduledToUtc` | `packages/time/src/index.ts` | `(date: string, hhmm: string) => Date` | 2.5 |
| `findScheduleInPast24h` | `packages/time/src/index.ts` | `(userId, now) => Schedule \| null` | 2.5 |
| `payoutForUser` | `apps/web/lib/services/payout.ts` | `(userId: string, month: string, db) => { hours, grossCent, adjustmentsCent, advancesCent, netCent }` | 2.5 |
| `writeAuditLog` | `apps/web/lib/services/audit.ts` | `(actor, action, entity, entityId, before?, after?) => Promise<AuditLog>` | 3 |

---

## 6. Service-layer helpers (consumed by route handlers)

| Function | Module | Phase |
|---|---|---|
| `consumeIdempotencyKey` | `apps/web/lib/services/idempotency.ts` | 2 |
| `consumeRateLimitToken` | `apps/web/lib/services/rateLimit.ts` | 2 |
| `userHasApprovedDayOffToday` | `apps/web/lib/services/dayOff.ts` | 2 |
| `resolveWatchedFlag` | `apps/web/lib/services/punch.ts` (called inside punch handler) | 4 |
| `tripThresholdScan` | `apps/worker/src/jobs/tripThreshold.ts` | 4 |
| `watchedDetectorScan` | `apps/worker/src/jobs/watchedDetector.ts` | 4 |
| `missedCheckoutScan` | `apps/worker/src/jobs/missedCheckout.ts` | 4 |
| `driverStaleScan` | `apps/worker/src/jobs/driverStale.ts` | 4 |
| `endOfDayWatcherScan` | `apps/worker/src/jobs/endOfDayWatcher.ts` | 4 |
| `dailySummaryScan` | `apps/worker/src/jobs/dailySummary.ts` | 5b |

---

## 7. Notification interface (`spec.md` §3.7)

```ts
// packages/notify/src/types.ts
export interface NotificationPayload {
  kind: 'EXCEPTION' | 'ROUTINE_PING' | 'DAILY_SUMMARY';
  template: string;          // e.g. 'watched.resolved', 'trip.over_threshold'
  context: Record<string, unknown>;
  recipientUserId?: string;  // defaults to admin
}

export interface Notifier {
  send(payload: NotificationPayload): Promise<void>;
}
```

Implementations:
- `ConsoleNotifier` — Phase 0 (logs to stdout). Selected when `NODE_ENV !== 'production'`.
- `TelegramNotifier` — Phase 5b. Sends via `https://api.telegram.org/bot{TOKEN}/sendMessage` with deep link.

Factory in `packages/notify/src/index.ts`:
```ts
export const notifier: Notifier =
  process.env.NODE_ENV === 'production'
    ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.PUBLIC_APP_URL)
    : new ConsoleNotifier();
```

---

## 8. Constants

| Name | Value | Where used |
|---|---|---|
| `SHOP_TZ` | `'Asia/Beirut'` | All timezone conversions |
| `BCRYPT_ROUNDS` | `12` | All password hashing |
| `PUNCH_RATE_LIMIT_PER_MIN` | `5` | `RateLimitBucket` refill |
| `LOGIN_RATE_LIMIT_PER_MIN` | `5` | `RateLimitBucket` refill |
| `IDEMPOTENCY_TTL_HOURS` | `24` | `IdempotencyKey.expires_at` |
| `MISSED_CHECKOUT_BUFFER_MIN` | `5` | Schedule_end + 30 + 5 = 35 min |
| `ADMIN_NOW_POLL_INTERVAL_MS` | `10_000` | Admin dashboard poll |
| `DRIVER_TRIP_POLL_INTERVAL_MS` | `30_000` | Driver banner poll |
| `SESSION_TTL_EMPLOYEE_MIN` | `120` | Employee session expiry (2h idle) |
| `SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN` | `30` | Driver session expiry (schedule_end + 30) |
| `CSRF_COOKIE_NAME` | `'csrf'` | Double-submit cookie pattern |
| `ACCESS_COOKIE_NAME` | `'ems_access'` | JWT |
| `REFRESH_COOKIE_NAME` | `'ems_refresh'` | JWT |

---

## 9. Environment variables

| Name | Example | Where used |
|---|---|---|
| `DATABASE_URL` | `postgresql://ems:ems@db:5432/ems` | Prisma |
| `JWT_SECRET` | 64-byte random hex | JWT signing |
| `TELEGRAM_BOT_TOKEN` | (from @BotFather) | Phase 5b |
| `TELEGRAM_WEBHOOK_SECRET` | 32-byte random hex | Phase 5b |
| `PUBLIC_APP_URL` | `https://app.example.com` | Deep links |
| `SENTRY_DSN` | (Sentry project) | Phase 6 |
| `BACKUP_GPG_PASSPHRASE_PATH` | `/run/secrets/backup.key` | Phase 6 |
| `RCLONE_CONFIG` | (path to rclone.conf) | Phase 6 |
| `NODE_ENV` | `production` \| `development` | Notifier selection |

---

## 10. Cron schedule (forward-declared from `spec.md` §3.9)

| Cron expression | Job | Phase |
|---|---|---|
| `*/1 * * * *` | watched-flag detector | 4 |
| `*/1 * * * *` | missed-checkout detector (schedule_end + 30 + 5 buffer) | 4 |
| `*/1 * * * *` | trip threshold detector | 4 |
| `*/30 * * * *` | driver-stale detector (no BACK in 4h) | 4 |
| `0 2 * * *` | nightly backup + retention + idempotency cleanup | 6 |
| `0 23 * * *` | daily closing summary | 5b |
| `30 23 * * *` | end-of-day WATCHED resolver | 4 |

---

## 11. Commit message format

```
phase-0: monorepo bootstrap
phase-1: auth + seed
phase-2: punch + geofence + employee pwa
phase-2.5-staging: deploy plumbing
phase-2.5-time: tests + impl
phase-2.5-geofence: tests + impl
phase-2.5-payout: tests + impl
phase-3: advances + adjustments + audit
phase-4: trips + schedule + leave + flags
phase-5a: admin dashboard ui
phase-5b: telegram + pdf + templates
phase-6: polish + pwa + observability + backups
fix(phase-N): <one-line summary>   # for bug fixes
```

---

## 12. What Phase 0 produced (status check)

| Item | Status |
|---|---|
| Monorepo scaffold (pnpm + workspaces) | ✅ |
| `packages/db/prisma/schema.prisma` copied verbatim from `spec.md` §6 | ✅ |
| `packages/notify/src/{types,console}.ts` stubbed | ✅ |
| `packages/time/src/index.ts` (date-fns-tz v2 API names) | ✅ |
| `docker-compose.yml` (web, worker, db) | ✅ |
| `Dockerfile.web`, `Dockerfile.worker` | ✅ |
| `apps/web/app/page.tsx` placeholder | ✅ |
| `apps/worker/src/index.ts` logs "cron runner started" | ✅ |
| `.env.example` with all env var names from §9 | ✅ |
| `.gitignore` | ✅ |
| `AGENTS.md` conventions file | ✅ |
| `pnpm install` clean | ✅ |
| Postgres healthy in Docker | ✅ |
| `prisma generate` works | ✅ |
| `pnpm --filter web dev` serves http://localhost:3000 | ✅ |
| `pnpm --filter worker dev` starts | ✅ |
| Initial commit on `main` | ✅ |
| CHECK constraint comments restored (fix(phase-0)) | ✅ commit `63bdacf` |
| .gitignore + docs committed (phase-0 hygiene) | ✅ commit `6f91abf` |

**Phase 0 status: COMPLETE.** Git history:
```
6f91abf phase-0: add .gitignore and commit documentation
63bdacf fix(phase-0): restore spec §6 inline comments for raw-SQL migrations
d5e4c65 phase-0: monorepo bootstrap
```

---

## 13. Phase 1 — Auth + DB foundation + seed

| Deliverable | Status |
|---|---|
| `apps/web/app/api/auth/login/route.ts` — POST, sets JWT cookies | ⏳ Phase 1 |
| `apps/web/app/api/auth/logout/route.ts` | ⏳ Phase 1 |
| `apps/web/app/api/auth/refresh/route.ts` | ⏳ Phase 1 |
| `apps/web/middleware.ts` — JWT decode, role guard | ⏳ Phase 1 |
| `apps/web/lib/auth/{session,jwt,csrf,password}.ts` | ⏳ Phase 1 |
| `apps/web/lib/db/prisma.ts` — singleton client | ⏳ Phase 1 |
| `apps/web/app/(public)/login/page.tsx` | ⏳ Phase 1 |
| `apps/web/app/(app)/admin/page.tsx` placeholder | ⏳ Phase 1 |
| `apps/web/app/(app)/employee/page.tsx` placeholder | ⏳ Phase 1 |
| `packages/db/prisma/seed.ts` — admin + 3 branches + 3 employees + RateChange rows | ⏳ Phase 1 |
| Raw-SQL migration: CHECK constraints + partial unique + REVOKE | ⏳ Phase 1 |
| `apps/web/lib/services/audit.ts` (writeAuditLog helper) | ⏳ Phase 1 |
| Unit tests: session, password, csrf, jwt | ⏳ Phase 1 |
| **End-of-Phase-1 invariant:** 3 RateChange rows after seed (1 per non-admin user) | ⏳ |