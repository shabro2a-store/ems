# API Contract — Shabro2a EMS

Every HTTP endpoint the app exposes. See [SYSTEM_MAP.md](SYSTEM_MAP.md) for the data
model and business rules.

## Conventions
- **Envelope**: success `{ "ok": true, "data": {...} }`; error
  `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
- **Auth**: a JWT in the httpOnly `ems_access` cookie. Middleware verifies it and
  injects `x-user-id` / `x-user-role` / `x-user-branch-id` request headers (clients
  cannot set these). Any `/api/me/*` or `/api/admin/*` request without a valid
  session gets `401 UNAUTHORIZED`. Each route additionally checks the role.
- **CSRF**: every state-changing request must send the `csrf` cookie value in an
  `X-CSRF-Token` header (double-submit). Failure → `403 FORBIDDEN` "CSRF token mismatch".
- **Idempotency**: POSTs marked *Idempotent* require an `Idempotency-Key` header;
  a replay within 24h returns the original response.
- **Rate limits**: login, punch, trip-start, advance — 5/min each → `429 RATE_LIMITED`
  (with `Retry-After` except login).
- **Money** is integer cents (USD). **Times** are ISO-8601 UTC; the business day is Asia/Beirut.
- Secrets (e.g. `password_hash`) are never returned.

Common error codes: `UNAUTHORIZED` 401, `FORBIDDEN` 403, `INVALID_INPUT` 400,
`NOT_FOUND` 404, `RATE_LIMITED` 429, plus domain codes noted per endpoint.

---

## Auth (public)

### POST /api/auth/login
Body `{ username, password }`. Rate-limited per (username, ip).
→ `200 { user: { id, username, role, branchId }, mustChangePassword }` and sets the
`ems_access`, `ems_refresh`, `csrf` cookies. Errors: `INVALID_INPUT`, `RATE_LIMITED`,
`UNAUTHORIZED` (unknown/inactive user or wrong password).

### POST /api/auth/logout
CSRF. Clears the auth cookies. → `200 { loggedOut: true }`.

### POST /api/auth/refresh
CSRF. Reads the `ems_refresh` cookie, rotates access + refresh + csrf. → `200 { refreshed: true }`.
Error: `UNAUTHORIZED`.

## Health (public)
- **GET /api/health** → `200 { uptime_s, version }`.
- **GET /api/health/db** → `200 { latency_ms }`, or `503 DB_UNREACHABLE` / `DB_SLOW`.

---

## Employee / self (`/api/me/*`, any signed-in role)

### GET /api/me/ping
→ `200 { userId, role, branchId }`.

### POST /api/me/punch  *(CSRF, Idempotent, rate-limited)*
Body `{ kind: "IN"|"OUT", lat, lng, accuracy, deviceFp }`. Enforces the
driver-open-trip block, geofence (accuracy + radius) and open-session rules; records
a punch with full GPS evidence and audit; may resolve a WATCHED flag. An approved
day-off does **not** block punching (staff may come in to help).
→ `200 { at, kind, minutes_since_in }`. Errors:
`OPEN_TRIP_EXISTS` 409, `ALREADY_PUNCHED_IN` 409, `NOT_PUNCHED_IN` 409,
`LOW_GPS_ACCURACY` 422, `OUT_OF_GEOFENCE` 422, plus the common ones.

### POST /api/me/punch/dev  *(CSRF; dev only)*
Enabled only when `ENABLE_DEV_ENDPOINTS=true`, else `404`. Body `{ kind }`. Skips
GPS/geofence (uses the branch centre) for testing on devices without GPS.

### GET /api/me/today
→ `200 { in_at, minutes_since_in, earned_today_cent, earned_month_cent,
approved_advance_balance_cent, net_cent }` — real earnings for the caller.

### GET /api/me/payroll?month=YYYY-MM
→ `200 { hours, gross_cent, adjustments_cent, advances_cent, penalties_cent, net_cent }`.

### GET /api/me/advances  ·  GET /api/me/advances?view=list
Summary `{ pending, approved_balance_cent }`, or `{ advances: [...] }` (latest 50).

### POST /api/me/advances  *(CSRF, Idempotent, rate-limited)*
Body `{ amountCent, reason? }`. Capped at what's earned this month —
worked wages + bonuses − deductions − advances already approved this month.
→ `200 { id, status: "PENDING" }`. Error: `EXCEEDS_ACCRUED_EARNINGS` 409.

### GET /api/me/leave  ·  POST /api/me/leave  *(POST: CSRF, Idempotent)*
Summary `{ pending, upcoming: [...] }`; request body
`{ kind: "DAY_OFF"|"TIME_CHANGE", start_date, end_date, start_time?, end_time?, note? }`.
→ `200 { id, status: "PENDING" }`. Error: `PAST_DATE` 400.

### Driver trips (role DRIVER)
- **POST /api/me/trip/start** *(CSRF, Idempotent, rate-limited)* `{ lat, lng, accuracy }`
  → `200 { trip_id, out_at }`. Errors: `OPEN_TRIP_EXISTS` 409, geofence 422, `NOT_DRIVER` 403.
- **POST /api/me/trip/end** *(CSRF, Idempotent)* `{ lat, lng, accuracy }`
  → `200 { trip_id, back_at, duration_min }`. Error: `NO_OPEN_TRIP` 409.
- **GET /api/me/trip/current** → `200 { open, since_min?, threshold_min }`.

### GET /api/me/calls  ·  POST /api/me/calls/ack  *(ack: CSRF)*
Driver ring inbox. `GET` → `{ ringing: bool, since }` (an unacknowledged ring in the last
2 min). `POST /ack` marks all pending rings acknowledged (dismiss the alarm).

### GET /api/me/push/key  ·  POST /api/me/push/subscribe  *(subscribe: CSRF)*
Web Push setup for the driver's device. `GET key` → `{ publicKey }` (null when push is
unconfigured server-side). `POST subscribe` `{ endpoint, keys: { p256dh, auth } }` stores the
device subscription (upsert by endpoint). → `{ subscribed: true }`.

### POST /api/me/password  *(CSRF, ADMIN only)*
Change your own password. **Admin only** — employees/drivers/callers get `403 FORBIDDEN`
(the admin resets their password instead). Body `{ currentPassword, newPassword }` (new ≥ 6
chars). → `200 { changed: true }`. Errors: `FORBIDDEN` 403, `WRONG_PASSWORD` 400.

---

## Admin (`/api/admin/*`, role ADMIN)

### Dashboard
- **GET /api/admin/overview?branchId=all|<id>** → live KPIs + per-employee status +
  attention queue: `{ branches, branchId, kpis{ present, absent, driversOut,
  driversOver, tripsToday, hoursToday, laborTodayCent }, people[] (drivers include
  trips_today), attention{ lateDrivers, flags, pendingAdvances, pendingLeaves } }`.
- **GET /api/admin/activity?branchId=&limit=** → `{ events: [{ id, type, username, at }] }`
  (punches + trips, newest first).
- **GET /api/admin/trends?branchId=&days=** → `{ points: [{ date, label, present, hours }] }`.
- **GET /api/admin/now** → legacy presence snapshot `{ branches, flags }` (superseded by
  `overview`; kept only because integration tests still exercise it).

### Employees
- **GET /api/admin/users** → `{ users: [...] }` (no `password_hash`).
- **POST /api/admin/users** *(CSRF, Idempotent)* `{ username, name?, password, role:
  "EMPLOYEE"|"DRIVER"|"CALLER", branchId, hourlyRateCent }` → `{ user, temp_password }`.
  `username` is the login; `name` is the display name. Creating an **ADMIN is
  rejected (403)**. **CALLER** needs a branch, gets no pay rate/RateChange, and is capped at
  **one active caller per branch** → `409 CALLER_EXISTS`.
- **PATCH /api/admin/users/[id]** *(CSRF)* `{ username?, name?, role?, branchId?,
  hourlyRateCent? }` (a rate change inserts a new `RateChange`; `username` is
  uniqueness-checked → `409 USERNAME_TAKEN`). Promoting to admin, or changing the
  admin's role, is **rejected (403)** (the admin's username/name are still editable).
- **POST /api/admin/users/[id]/reset-password** *(CSRF)* optional `{ password }` —
  sets that password, or generates a random one. → `{ temp_password }`.
- **POST /api/admin/users/[id]/deactivate** *(CSRF)* toggles active. Deactivating an
  **admin is rejected (403)**.
- **PATCH /api/admin/users/[id]/notification-prefs** *(CSRF)* `{ dailySummary?, routinePings? }`.
- **GET /api/admin/schedules/[userId]** → `{ weeklySchedule, overrides, pendingLeaves }`.
- **PUT /api/admin/schedules/[userId]** *(CSRF)* `{ weeklySchedule: [{ weekday 0-6,
  start_time, end_time }] }` (full replace).

### Branches
- **GET /api/admin/branches** → `{ branches: [...] }`.
- **POST /api/admin/branches** *(CSRF)* `{ name, lat?, lng?, gpsRadiusM?,
  gpsAccuracyMaxM?, absentGraceMin?, tripThresholdMin? }` → `{ branch }`.
- **PATCH /api/admin/branches/[id]** *(CSRF)* any of the above fields + `isActive`.
- **DELETE /api/admin/branches/[id]** *(CSRF)* → `{ deleted, archived }`. Hard-deletes
  an empty branch; archives (is_active=false) one that has staff/punch/trip history.

### Punches
- **GET /api/admin/punches?branchId=&userId=&from=&to=&limit=** → `{ punches: [...] }`
  (includes `corrected`, `correction_reason`, user, branch).
- **POST /api/admin/punches/correct** *(CSRF, Idempotent)* `{ punchId, newAt?,
  newBranchId?, reason }` — **persists** the correction (sets `corrected`,
  `corrected_by`, `correction_reason`) and audits before/after. GPS evidence is kept.

### Pay & approvals
- **GET /api/admin/payroll?month=YYYY-MM&branchId=** → `{ rows[], totals, month,
  branchId, branches }`. Each row + `totals` include `gross_cent`, `adjustments_cent`,
  `penalties_cent`, `advances_cent`, `net_cent`.
- **GET /api/admin/reports/payroll?month=&branchId=** → a **PDF** (`application/pdf`),
  scoped to the branch filter.
- **POST /api/admin/adjustments** *(CSRF, Idempotent)* `{ userId, kind:
  "BONUS"|"DEDUCTION", amountCent, reason }` → `{ adjustment }`.
- **GET /api/admin/advances** → pending `{ advances: [...] }`.
- **POST /api/admin/advances/[id]/decision** *(CSRF, Idempotent)* `{ decision:
  "APPROVED"|"REJECTED" }`. Error: `ALREADY_DECIDED` 409.
- **POST /api/admin/leave/[id]/decision** *(CSRF, Idempotent)* `{ decision }` →
  `{ id, status, overrides_created }` (approval materializes ScheduleOverrides).

### Penalties
Late / early-leave penalties are **computed** from schedule vs punches
(`min(4, floor(minutesLate / 15))` hours × rate), not stored. Both surface in
payroll as `penalties_cent` and reduce `net_cent`.
- **GET /api/admin/penalties?userId=&month=YYYY-MM** → `{ penalties: [{ date, kind:
  "LATE"|"EARLY_LEAVE", minutes, hours, rate_cent, amount_cent, waived }] }`.
- **POST /api/admin/penalties/waive** *(CSRF)* `{ userId, date: "YYYY-MM-DD", kind:
  "LATE"|"EARLY_LEAVE", waived: bool, reason? }` — removes (`waived:true`) or
  re-applies (`waived:false`) one auto-penalty. Only ever writes `PenaltyWaiver`
  rows; never a manual adjustment. → `{ waived }`.

### Flags
- **POST /api/admin/flags/[id]/resolve** *(CSRF)* — acknowledges a flag
  (sets `notified_at`); audited. → `{ id, resolved_at }`.

---

## Caller (`/api/caller/*`, role CALLER)

The POS caller's board. A caller belongs to one branch and can only see/ring drivers there.

### GET /api/caller/drivers
→ `{ branch, drivers: [{ id, username, name, clocked_in, available, open_trip_since,
trips_today, ringing }] }`. `available` = clocked in and not on a trip; `trips_today` counts
trips since this shift's clock-in.

### POST /api/caller/ring  *(CSRF)*
Body `{ driverId }`. Records a ring the driver's app picks up. → `{ rang: true }`.
Errors: `WRONG_BRANCH` 403 (driver not in caller's branch), `NOT_FOUND` 404.

## Telegram

### POST /api/telegram/webhook (public, secret-guarded)
Guarded by the `x-telegram-bot-api-secret-token` header vs `TELEGRAM_WEBHOOK_SECRET`.
On `/start`, binds the sender's chat id to the admin user. → `200 { bound }` / `{ skipped }`.
