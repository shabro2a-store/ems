# Shabro2a EMS — System Map (source of truth)

Time-and-attendance for a multi-branch supermarket in Beirut: geofenced punch
in/out, driver trips, monthly payroll (money in **integer cents**), leave/day-off
scheduling, cash advances, and a Telegram-notifying cron worker. Business timezone:
**Asia/Beirut**. Response envelope everywhere: `{ ok: true, data }` or
`{ ok: false, error: { code, message } }`.

Stack: Next.js 14 (App Router) web app + a `node-cron` worker + Postgres (Prisma).
Packages: `db` (schema/seed), `time` (Beirut tz), `notify` (Telegram), `pdf` (payroll PDF).

**Status:** fully redesigned admin + field UI, shipped and running in production.
The one remaining planned feature is the notification wiring (see §9).

---

## 1. Roles, Auth & account rules

| Role | Can do |
|---|---|
| EMPLOYEE | Punch in/out (geofenced), view today/payroll, request advances & leave |
| DRIVER | Trip out/back (geofenced) + everything an employee can (cannot punch while a trip is open); receives caller "ring" alarm |
| CALLER (POS cashier) | Read-only board of the branch's drivers (live status + trips today) and a **Ring** button per driver. One active caller per branch. Rings only — never starts/ends trips. Not paid hourly, not in payroll. |
| ADMIN (owner) | Everything: live dashboard, employees + schedules, branches + GPS, punches + corrections, payroll + PDF, approvals |

- **Login** issues 3 cookies: `ems_access` (JWT, httpOnly), `ems_refresh` (JWT, httpOnly, 7d), `csrf` (readable).
- **Middleware** verifies the access JWT and injects `x-user-id` / `x-user-role` /
  `x-user-branch-id` headers (clients cannot spoof them). Any `/api/me/*` or `/api/admin/*`
  without a valid session → `401`. Each route re-checks the role.
- **CSRF**: every state-changing route validates `X-CSRF-Token` vs the `csrf` cookie
  (double-submit; both sides URL-decoded — the encoding bug is fixed).
- **Idempotency**: mutating POSTs require an `Idempotency-Key` (24h dedupe).
- **Rate limits**: login (per user+IP), punch, trip-start, advance — 5/min token bucket → `429`.
- **Identity**: `username` = login handle (unique); `name` = display name shown in the
  app (greetings, admin bar, lists). **Only the admin manages passwords** — the admin
  changes their own (`POST /api/me/password`, ADMIN-only) and sets/resets every other
  user's (`POST /api/admin/users/[id]/reset-password`). Employees/drivers/callers have no
  self-service password change.
- **Admin protection**: the admin account cannot be created via the app, promoted/demoted,
  or deactivated (fail-closed with 403). `password_hash` is never returned to the client.
- Session TTL: employee 120 min; driver 30 min after scheduled end. `mustChangePassword`
  is returned when the password equals the seed default `change-me`.

---

## 2. Data Model (Prisma / Postgres)

cuid PKs, money = Int cents.

- **User** — username(unique), **name?** (display), password_hash, role, branch_id?,
  hourly_rate_cent, is_active, telegram_chat_id?, notify_daily_summary, notify_routine_pings.
- **Branch** — name, lat, lng, gps_radius_m(50), gps_accuracy_max_m(100), absent_grace_min(15),
  trip_threshold_min(30), is_active.
- **Punch** — user, branch, kind(IN/OUT), at, evidence(lat/lng/accuracy_m/device_fp/ip),
  correction(corrected/corrected_by/correction_reason). Indexed by (user,at),(branch,at).
- **RateChange** — point-in-time hourly rate history (payroll uses the rate in effect at each shift).
- **Schedule** — one row per (user, weekday 0=Sun..6=Sat): start_time/end_time "HH:MM" Beirut.
- **ScheduleOverride** — one per (user, date): DAY_OFF or TIME_CHANGE. DAY_OFF blocks punching.
- **LeaveRequest** — kind, start/end date, optional times, status. Approval → ScheduleOverride rows.
- **Trip** — driver, branch, out_at/lat/lng, back_at/lat/lng?, over_threshold, threshold_alerted_at.
  **Partial unique index: one open trip per driver.**
- **Advance** — amount_cent, reason?, status. Approved advances reduce net pay (by created_at month).
- **Adjustment** — period(1st of month), kind(BONUS/DEDUCTION), amount_cent(≥0, sign from kind), reason.
- **DriverCall** — a caller ringing a driver (driver, caller, branch?, created_at, acknowledged_at?).
  The driver's app polls for an unacknowledged ring in the last 2 min and raises the alarm.
- **PushSubscription** — a device's Web Push subscription (user, endpoint unique, p256dh, auth);
  lets a ring reach a locked/closed phone. Dead endpoints (404/410) are auto-pruned.
- **PenaltyWaiver** — (user, date, kind LATE/EARLY_LEAVE) unique. Penalties themselves are
  **computed on the fly** (schedule vs punches, see §4), not stored; a waiver is the admin
  "remove penalty" for one (user, day, kind) and can never touch an Adjustment.
- **Flag** — kind(WATCHED / MISSED_CHECKOUT / TRIP_OVER_THRESHOLD), user?, branch?, context_json,
  notified_at?(= resolved/acknowledged marker).
- **AuditLog** — append-only (DB revokes UPDATE/DELETE). actor/action/entity/before/after.
- **IdempotencyKey** — (key,user)→cached response, 24h TTL. **RateLimitBucket** — token bucket store.

---

## 3. API Endpoints

Full request/response detail is in [API.md](API.md). Summary:

**Auth (public)**: `POST /api/auth/login|logout|refresh`.
**Health (public)**: `GET /api/health`, `GET /api/health/db`.

**Employee/self `/api/me/*`** (any role): `GET ping` · `POST punch` (geofenced) ·
`POST punch/dev` (dev-only) · `GET today` (real earnings) · `GET payroll?month` ·
`GET/POST advances` · `GET/POST leave` · `POST trip/start|end`, `GET trip/current` (DRIVER) ·
`GET calls` / `POST calls/ack` (driver ring poll + dismiss) · `GET push/key` /
`POST push/subscribe` (Web Push setup) · `POST password` (ADMIN-only).

**Caller `/api/caller/*`** (CALLER): `GET drivers` (branch driver board — live status + trips today) ·
`POST ring` (ring a driver in the caller's branch).

**Admin `/api/admin/*`** (ADMIN):
- Dashboard: `GET overview?branchId` (KPIs + people + attention queue) · `GET activity` ·
  `GET trends` · `GET now` (legacy, test-only).
- Employees: `GET users` (no password_hash) · `POST users` (name/username/role/branch/rate;
  ADMIN role rejected) · `PATCH users/[id]` (username/name/role/branch/rate; admin protected) ·
  `POST users/[id]/reset-password` (chosen or random) · `POST users/[id]/deactivate` (admin protected) ·
  `PATCH users/[id]/notification-prefs` · `GET/PUT schedules/[userId]`.
- Branches: `GET branches` · `POST branches` (create) · `PATCH branches/[id]` ·
  `DELETE branches/[id]` (delete if empty, else archive).
- Punches: `GET punches?branchId&userId&from&to` · `POST punches/correct` (persists the correction).
- Pay & approvals: `GET payroll?month&branchId` · `GET reports/payroll?month&branchId` (**PDF**, branch-aware) ·
  `POST adjustments` · `GET advances` · `POST advances/[id]/decision` ·
  `POST leave/[id]/decision`.
- Penalties: `GET penalties?userId&month` (computed list + waived flag) · `POST penalties/waive`
  (remove/restore one auto-penalty; never touches adjustments).
- Flags: `POST flags/[id]/resolve`.

**Telegram**: `POST /api/telegram/webhook` (secret-guarded; `/start` binds admin chat_id).

---

## 4. Business Rules (services)

- **Payroll (`payout.ts`)**: pairs each IN with next OUT; `minutes = floor((out-in)/60000)`;
  interval gross = `floor(minutes * rate_at_shift / 60)` (respects RateChange history). Open
  session pays nothing. `net = gross + Σadjustments − ΣapprovedAdvances(month) − Σpenalties(month)`.
  Can go negative.
- **Penalties (`penalty.ts`)**: unannounced lateness / early-leave, docked from pay.
  `penaltyHours = min(4, floor(minutesLate / 15))` — under 15 min is free (grace), then 1 hour
  per 15-min block, capped at 4h; same rule for leaving before the scheduled end. Measured from
  each day's first IN / last OUT vs the employee's Schedule (respecting overrides; DAY_OFF and
  unscheduled days are skipped; the current day is skipped for early-leave). Computed on the fly
  (not stored); an admin **waiver** removes one. Penalty amount = hours × rate-at-shift.
- **Punch (`punch.ts`)** gate order: user active+branch → day-off block → driver open-trip block →
  geofence (accuracy then radius) → session state. Writes full evidence + audit; resolves the
  oldest open WATCHED flag atomically.
- **Geofence (`geofence.ts`)**: nearest active branch by haversine; reject if
  `accuracy > gps_accuracy_max_m` or `distance ≥ radius + accuracy`.
- **Trips (`trip.ts`)**: one open trip per driver (service + DB index); geofenced both ends.
- **Advances**: an employee can borrow against everything earned **this month** —
  worked wages **plus bonuses, minus deductions and penalties**: capped so
  `approvedBalance + amount ≤ grossThisMonth + adjustmentsThisMonth − penaltiesThisMonth`. Approved
  advances counted in the cap are scoped to the current month, so the limit
  refills at the start of each month (payroll's month boundary).
- **Leave**: approval upserts one ScheduleOverride per date in range.
- **Time (`time`)**: Beirut day boundaries, weekday Sun=0..Sat=6, schedule wall-clock → UTC.

---

## 5. Worker Cron Jobs

| Schedule | Job | Does |
|---|---|---|
| every 1 min | watchedDetector | Flags scheduled employees with no punch 30 min after shift start (WATCHED flag) |
| every 1 min | missedCheckout | Still clocked in 35 min past shift end → MISSED_CHECKOUT flag + notify |
| every 1 min | tripThreshold | Open trip past branch threshold → set over_threshold + notify |
| every 30 min | driverStale | Trip open ≥ 4h → notify |
| 23:30 daily | endOfDayWatcher | Unresolved WATCHED flags → notify + close |
| 23:00 daily | dailySummary | Attendance roll-up (all + per branch) → notify |

Notifications go to Telegram when `TELEGRAM_BOT_TOKEN` is set (admin binds via `/start`);
otherwise a console notifier. Telegram messages are **informational only** (a smart summary +
an "Open in app" deep link) — all actions happen in the web app.

---

## 6. Design system & UI

- **Tokens**: CSS variables in `apps/web/app/globals.css`, mapped in `tailwind.config.ts` —
  slate ground, white surfaces, one blue accent; semantic success/danger/warning kept separate.
  Light theme, English/LTR.
- **Primitives**: `apps/web/components/ui/*` — Button, Card, Badge/StatusDot, Field/Input/Select/
  Textarea, Modal, PageHeader, StatTile, EmptyState, Spinner, Alert.
- **Shared client helper**: `apps/web/lib/api.ts` — `apiGet`/`apiSend` (CSRF + Idempotency-Key
  handled once), `errorMessage` (human message, not codes), money/Beirut-time formatters.
- **Admin shell**: `app/(app)/admin/layout.tsx` (server) enforces ADMIN, resolves the display
  name + live flag count, renders `AdminNav`. Nav is **5 tabs**: Dashboard · Employees · Branches ·
  Punches · Payroll. (Approvals/flags live in the dashboard; schedules in Employees; adjustments in Payroll.)
- **Field shell**: `components/field/FieldShell.tsx` — mobile top bar (brand + Password + Logout)
  and a bottom tab nav (Home/Trip · Advances · Leave · Pay), role-aware. Wraps `/employee/*` and `/driver/*`.

---

## 7. Screens

- **Public**: `/login` (branded).
- **Admin** (desktop-first, responsive): `/admin` command center (branch filter, KPIs + labor,
  live per-employee status, weekly trends chart, needs-attention with inline approve/reject/resolve,
  activity feed) · `/admin/users` (Employees: branch filter, add/edit incl. name+username, rate,
  reset/set password, deactivate, per-employee weekly schedule) · `/admin/branches` (create/edit/
  remove, record GPS) · `/admin/punches` (log + persistent correction) · `/admin/payroll` (month +
  branch filter, totals incl. **Total to pay / Adjustments / Penalties**, editable rate, inline
  adjustments, per-employee penalties with **Remove/Restore**, branch-aware PDF).
- **Employee** (phone): `/employee` (punch + today/earnings, greets by name) ·
  `/employee/advances` · `/employee/leave` · `/employee/payroll`.
- **Driver** (phone): `/driver` — **clock in/out** (attendance punch) **and** trip out/back
  off one GPS check (must clock in before going out on an order), shift/earnings tiles, greets
  by name, + the same advances/leave/pay tabs. Shows a full-screen flashing **alarm** (sound +
  vibration) when the caller rings; polls `GET /api/me/calls`, dismiss acks it.
- **Caller** (`/caller`, POS/tablet): each branch driver is a big button — available ones
  bright and sorted to the top, out/off ones dimmed and sunk to the bottom (the "lights off"
  metaphor); shows live Out timer + trips today; tap = ring. Polls every 3s.
- The **admin dashboard** also shows a **Trips today** KPI and per-driver trip counts.

---

## 8. Resolved findings

The bugs found in the initial audit are fixed:
- Correct-punch now **persists** (sets corrected/corrected_by/correction_reason).
- `/api/me/today` returns **real earnings** (today + month + advances + net).
- Schedule editing moved into the **Employees** page (the old advances-fed dropdown is gone).
- Every admin page has nav (single `admin/layout.tsx`); the bar shows the **display name**;
  flag badge is accurate.
- **create-branch** and **remove-branch** endpoints added; payroll **PDF honors the branch filter**.
- Error UI shows human messages; CSRF/idempotency/modal boilerplate extracted to shared helpers.
- Security: admin account protected; `password_hash` never returned; self + admin password management.

## 9. Outstanding

**Caller ring** is fully shipped: a loud in-app alarm while the app is open **plus** Web Push
(`push.ts` + service worker + VAPID) so it also reaches a **locked/closed** phone — solid on
Android; iPhones must "Add to Home Screen" (install the PWA) on iOS 16.4+. Push is optional:
with no VAPID keys set it degrades to the in-app alarm only. Setup: see DEPLOY.md.

### "Needs Attention → Telegram" — the last planned feature (spec)

The Telegram **transport** (`packages/notify/src/telegram.ts`) and the `/start` chat-id binding
(`/api/telegram/webhook`) are correct and wired. Everything **upstream** needs work. Fixes, in
priority order (each verified against the code by an audit):

1. **Web app never sends to Telegram (blocker).** The web `notifier` export is a hardcoded
   `ConsoleNotifier` ([packages/notify/src/index.ts:43](packages/notify/src/index.ts)); the punch
   route calls `punchEmployee` without passing a notifier, so it uses that console one. Only the
   **worker** uses `getNotifier()`. → Route web callers (punch, and #3) through `getNotifier()` so
   web-originated alerts can reach Telegram when a token is set.
2. **Template key typo (blocker).** `punch.ts` sends `template: 'watched.resolved'` but the only
   template is `'watched_resolved'` → falls to the default branch and renders raw JSON. → Make the
   keys match (rename one).
3. **Advance request sends no alert (bug).** `requestAdvance` (and `/api/me/advances`) never notify;
   the `advance_requested` template is defined but never fired. → Send it on request.
4. **`driverStale` re-alerts every 30 min (bug).** No per-trip guard (unlike `tripThreshold`'s
   `threshold_alerted_at`). → Add a `stale_alerted_at` field on `Trip` and gate on it.
5. **`tripThreshold` writes no Flag (design gap).** It sets `over_threshold`/`threshold_alerted_at`
   on the Trip but never creates a `TRIP_OVER_THRESHOLD` Flag, so over-threshold trips reach the
   dashboard only via the separate live `lateDrivers` computation, not the flags list. → Either
   create the flag (so it's resolvable) or accept the live path and drop the unused enum value.
6. **"Late driver" attention row is not actionable (UX).** It has no button/endpoint, unlike flags/
   advances/leaves. → Give it an action or relabel it as informational.
7. **`Flag.notified_at` is overloaded (consistency bug).** It means both "alert sent" and "admin
   resolved": `endOfDayWatcher` sets it when *sending* the 23:30 alert, silently dropping WATCHED
   flags off the attention list with no admin action; `missedCheckout` never sets it. → Add a
   distinct `resolved_at` so alerting and resolution don't collide.

Also planned: an in-app notification **bell** fed by the same events (informational; actions stay
in the web app). Needs the client's `TELEGRAM_BOT_TOKEN` (+ `/start`) for the real end-to-end test.

Minor: trips write no separate AuditLog entry; three notify templates are currently unreachable
(`advance_requested`, `end_of_day_watched`, and — until #2 — `watched_resolved`).
