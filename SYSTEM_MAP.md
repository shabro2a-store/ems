# Supermarket EMS — System Map (source of truth)

Employee management / time-and-attendance for a multi-branch supermarket: geofenced
punch in/out, driver trips, monthly payroll (money in **integer cents**), leave/day-off
scheduling, cash advances, and a Telegram-notifying cron worker. Business timezone:
**Asia/Beirut**. Response envelope everywhere: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

Stack: Next.js 14 (App Router) web app + a `node-cron` worker + Postgres (Prisma).
Monorepo packages: `db` (schema/seed), `time` (Beirut tz), `notify` (Telegram), `pdf` (payroll PDF).

---

## 1. Roles & Auth

| Role | Can do |
|---|---|
| EMPLOYEE | Punch in/out (geofenced), view today/payroll, request advances & leave |
| DRIVER | Trip out/back (geofenced), view today/payroll, advances & leave (cannot punch while a trip is open) |
| ADMIN (owner) | Everything admin: live dashboard, users, branches, punches, adjustments, advances, leave, schedules, payroll + PDF, flags |

- **Login** issues 3 cookies: `ems_access` (JWT, httpOnly), `ems_refresh` (JWT, httpOnly, 7d), `csrf` (readable).
- **Middleware** verifies the access JWT and injects `x-user-id` / `x-user-role` / `x-user-branch-id` headers (clients cannot spoof them). Any `/api/me/*` or `/api/admin/*` without a valid session → `401`.
- **CSRF**: every state-changing route validates the `X-CSRF-Token` header against the `csrf` cookie (double-submit). *(Fixed in phase-9 — see build history.)*
- **Idempotency**: mutating POSTs require an `Idempotency-Key` header (24h dedupe window).
- **Rate limits**: login (per user+IP), punch, trip-start, advance — all 5/min, token bucket, `429` + `Retry-After`.
- Session TTL: employee 120 min; driver 30 min after scheduled end. `mustChangePassword` returned when the password equals the seed default `change-me`.

---

## 2. Data Model (Prisma / Postgres)

Entities and key relationships (cuid PKs, money = Int cents):

- **User** — username(unique), password_hash, role, branch_id?, hourly_rate_cent, is_active, telegram_chat_id?, notify_daily_summary, notify_routine_pings.
- **Branch** — name, lat, lng, gps_radius_m(50), gps_accuracy_max_m(100), absent_grace_min(15), trip_threshold_min(30), is_active.
- **Punch** — user, branch, kind(IN/OUT), at, evidence(lat/lng/accuracy_m/device_fp/ip), correction(corrected/corrected_by/correction_reason). Indexed by (user,at),(branch,at).
- **RateChange** — point-in-time hourly rate history (payroll uses the rate in effect at each punch).
- **Schedule** — one row per (user, weekday 0=Sun..6=Sat): start_time/end_time "HH:MM" Beirut.
- **ScheduleOverride** — one per (user, date): DAY_OFF or TIME_CHANGE. DAY_OFF blocks punching. Materialized from approved leave.
- **LeaveRequest** — kind, start/end date, optional times, status(PENDING/APPROVED/REJECTED). Approval → ScheduleOverride rows.
- **Trip** — driver, branch, out_at/lat/lng, back_at/lat/lng?, over_threshold, threshold_alerted_at. **Partial unique index: one open trip per driver.**
- **Advance** — amount_cent, reason?, status. Approved advances reduce net pay (attributed to created_at month).
- **Adjustment** — period(1st of month), kind(BONUS/DEDUCTION), amount_cent(≥0, sign from kind), reason, created_by.
- **Flag** — kind(WATCHED / MISSED_CHECKOUT / TRIP_OVER_THRESHOLD), user?, branch?, context_json, notified_at?(= resolved marker).
- **AuditLog** — append-only (DB revokes UPDATE/DELETE). actor/action/entity/before/after.
- **IdempotencyKey** — (key,user) → cached response, 24h TTL. **RateLimitBucket** — token bucket store.

---

## 3. API Endpoints (41 handlers, 35 route files)

### Auth (public)
| Method Path | Notes |
|---|---|
| POST /api/auth/login | username+password → sets cookies; rate-limited; returns user + mustChangePassword |
| POST /api/auth/logout | CSRF; clears cookies |
| POST /api/auth/refresh | CSRF; rotates access+refresh from refresh cookie |

### Health (public)
| GET /api/health | uptime+version |
| GET /api/health/db | `SELECT 1` latency; 503 if unreachable/slow(>50ms) |

### Employee / me (any authenticated role)
| Method Path | Notes |
|---|---|
| GET /api/me/ping | {userId, role, branchId} |
| POST /api/me/punch | CSRF+Idem+rate. Geofence + day-off + open-trip + session checks → creates Punch, resolves watched flag, audit |
| POST /api/me/punch/dev | Dev-only (ENABLE_DEV_ENDPOINTS), skips GPS |
| GET /api/me/today | open IN + minutes; **earnings fields currently hard-coded 0 (BUG #2)** |
| GET /api/me/payroll?month | payout for month |
| GET/POST /api/me/advances | summary/list; request (CSRF+Idem+rate, capped at accrued gross) |
| GET/POST /api/me/leave | summary; request (CSRF+Idem) |
| POST /api/me/trip/start,end | DRIVER only, CSRF+Idem, geofenced |
| GET /api/me/trip/current | DRIVER only |

### Admin (ADMIN only)
| Method Path | Notes |
|---|---|
| GET /api/admin/ping | identity |
| GET/POST /api/admin/users | list; create (+RateChange, temp password) |
| PATCH /api/admin/users/[id] | role/branch/rate (rate change → new RateChange) |
| POST /api/admin/users/[id]/reset-password | temp password |
| POST /api/admin/users/[id]/deactivate | **toggles** active/inactive |
| PATCH /api/admin/users/[id]/notification-prefs | daily-summary / routine-pings |
| GET /api/admin/branches | list |
| GET /api/admin/branches/[id] | **returns ALL branches, ignores id (quirk)** |
| PATCH /api/admin/branches/[id] | edit branch/geofence config |
| GET /api/admin/punches | filtered list (branch/user/date) |
| POST /api/admin/punches/correct | **audit-only — does NOT persist correction (BUG #1)** |
| POST /api/admin/adjustments | create BONUS/DEDUCTION for current month |
| GET /api/admin/advances | pending list |
| POST /api/admin/advances/[id]/decision | approve/reject |
| GET /api/admin/leave | list (optional status) |
| POST /api/admin/leave/[id]/decision | approve(→overrides)/reject |
| GET/PUT /api/admin/schedules/[userId] | read weekly+overrides+pending; replace weekly schedule |
| GET /api/admin/now | live dashboard (present/absent/driversOut per branch + today flags) |
| GET /api/admin/payroll?month | per-user payroll rows + totals |
| GET /api/admin/reports/payroll?month | **PDF** download |

### Telegram
| POST /api/telegram/webhook | secret-guarded; `/start` binds admin chat_id |

**No branch-create endpoint exists** (branches can only be edited). *(Gap — see findings.)*

---

## 4. Business Rules (services)

- **Payroll (`payout.ts`)**: pairs each IN with next OUT; `minutes = floor((out-in)/60000)`; interval gross = `floor(minutes * rate_at_OUT_time / 60)`. Open session pays nothing. `net = gross + Σadjustments − ΣapprovedAdvances(this month)`. Net can go negative.
- **Punch (`punch.ts`)** gate order: user active+branch → day-off block → driver open-trip block → geofence (accuracy then radius) → session state (already-in / not-in). Writes full evidence + audit; resolves oldest open WATCHED flag atomically.
- **Geofence (`geofence.ts`)**: nearest active branch by haversine; reject if `accuracy > gps_accuracy_max_m` (LOW_GPS_ACCURACY) or `distance ≥ radius + accuracy` (OUT_OF_GEOFENCE).
- **Trips (`trip.ts`)**: one open trip per driver (service + DB index); geofenced at both ends; duration in minutes.
- **Advances (`advances.ts`)**: capped so `approvedBalance + amount ≤ accrued gross this month`.
- **Leave (`leave.ts`)**: approval upserts one ScheduleOverride per date in range.
- **Time (`time` pkg)**: Beirut day boundaries, weekday Sun=0..Sat=6, schedule wall-clock → UTC.

---

## 5. Worker Cron Jobs

| Schedule | Job | Does |
|---|---|---|
| every 1 min | watchedDetector | Flags scheduled employees with no punch 30 min after shift start (WATCHED flag; no notify) |
| every 1 min | missedCheckout | Still clocked in 35 min past shift end → MISSED_CHECKOUT flag + notify |
| every 1 min | tripThreshold | Open trip past branch threshold → set over_threshold + notify (**no TRIP_OVER_THRESHOLD flag written — BUG #7**) |
| every 30 min | driverStale | Trip open ≥ 4h → notify (**no dedupe → re-notifies every 30 min — BUG #6**) |
| 23:30 daily | endOfDayWatcher | Unresolved WATCHED flags → notify + close |
| 23:00 daily | dailySummary | Attendance roll-up (all + per branch) → notify |

---

## 6. Notification Catalog (Telegram)

| Template | Fired by | Trigger | Deep link |
|---|---|---|---|
| missed_checkout | missedCheckout job | open IN 35m past shift end | /admin/punches |
| trip.over_threshold | tripThreshold job | trip past branch threshold | /admin |
| driver.stale | driverStale job | trip open ≥ 4h | /admin |
| watched.unresolved | endOfDayWatcher job | WATCHED flag open at EOD | /admin/flags |
| daily_summary | dailySummary job | 23:00 all + per branch | /admin |
| watched.resolved | punch.ts | watched user punches | **key mismatch → renders raw fallback (BUG #3)** |
| advance_requested | (defined, **never fired** — BUG #5) | should fire when advance requested | /admin/pending |
| end_of_day_watched | (defined, unused) | — | — |

---

## 7. Screens (current)

Public: `/login`. Employee (phone): `/employee` (punch), `/employee/advances`, `/employee/leave`, `/employee/payroll`.
Driver (phone): `/driver` (trip out/back). Admin (desktop): `/admin` (live dashboard), `/admin/users`,
`/admin/branches`, `/admin/adjustments`, `/admin/punches`, `/admin/flags`, `/admin/pending`,
`/admin/payroll`, `/admin/schedule`, `/admin/users/[id]/edit`.

UI today: raw stock Tailwind, no shared components, no design tokens, no brand color. See findings.

---

## 8. Verification Findings (what to fix before demo)

**Severity 1 — behaves wrong / demo-breaking**
1. **Correct-punch does nothing** — `/api/admin/punches/correct` writes an audit entry but never updates the Punch row (schema has `corrected`/`corrected_by`/`correction_reason` fields ready but unused).
2. **Employee "today" earnings are fake** — `/api/me/today` returns hard-coded 0 for earned_today/earned_month/net.
3. **Watched-resolved Telegram alert is garbled** — `punch.ts` sends `watched.resolved` but the template is `watched_resolved`; renders as raw JSON.
4. **Schedule editor can't reach most staff** — user dropdown is built from the *advances* endpoint, so only employees with an advance appear.

**Severity 2 — structural / UX**
5. **Advance requests never notify admin** — `advance_requested` template exists but `requestAdvance` doesn't send it.
6. **driverStale spams** — no dedupe, re-notifies every 30 min for the same stuck trip.
7. **tripThreshold writes no flag** — `TRIP_OVER_THRESHOLD` never appears on the Flags page despite the enum + filter existing.
8. **3 admin pages have no nav** (payroll, pending, schedule) — dead ends. Should live in an `admin/layout.tsx`.
9. **Admin header shows a raw user id** instead of a username; flag badge hard-coded 0 on most pages.
10. **PWA broken** — manifest has empty `icons`, isn't linked in `<head>`, no viewport/theme-color meta.

**Severity 3 — polish / cleanup**
11. Error UI shows codes (e.g. "VALIDATION") not the human `error.message` the API returns.
12. `csrfFromCookie` / `idemKey` / modal / stat-card markup copy-pasted across ~10 files → extract shared helpers/components.
13. Schedule user-switch does a full `window.location.reload()`.
14. Admin tables overflow on mobile; schedule weekly grid is cramped.
15. `admin/branches/[id]` GET ignores the id (return-all quirk).
