# Shabro2a EMS — System Map (source of truth)

Time-and-attendance for a multi-branch supermarket in Beirut: geofenced punch
in/out, driver trips, monthly payroll (money in **integer cents**), leave/day-off
scheduling, cash advances, and a Telegram-notifying cron worker. Business timezone:
**Asia/Beirut**. Response envelope everywhere: `{ ok: true, data }` or
`{ ok: false, error: { code, message } }`.

Stack: Next.js 14 (App Router) web app + a `node-cron` worker + Postgres (Prisma).
Packages: `db` (schema/seed), `time` (Beirut tz), `notify` (Telegram), `pdf` (payroll PDF).

**Status:** feature-complete and running in production. Everything below is built,
tested and deployed. What remains is operational rather than developmental: linking
the Telegram bot (see [DEPLOY.md](DEPLOY.md)) and the two known issues in §9.

**This document describes `master`.** Production only matches it after a deploy —
check `/api/health`'s `uptime_s` if in doubt.

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
- **DriverCall** — a caller ringing a driver (driver, caller, branch?, created_at, acknowledged_at?,
  trip_id?). The driver's app polls for an unacknowledged ring in the last 2 min and raises the
  alarm. `trip_id` links the ring to the trip it dispatched; a driver can only start a trip against
  a recent ring with no `trip_id` yet.
- **PushSubscription** — a device's Web Push subscription (user, endpoint unique, p256dh, auth);
  lets a ring reach a locked/closed phone. Dead endpoints (404/410) are auto-pruned.
- **PenaltyWaiver** — (user, date, kind LATE/EARLY_LEAVE) unique. Penalties themselves are
  **computed on the fly** (schedule vs punches, see §4), not stored; a waiver is the admin
  "remove penalty" for one (user, day, kind) and can never touch an Adjustment.
- **PenaltyAck** — (user, date, kind) unique. The admin saw an auto-penalty and let it
  stand. Changes **no money** — it exists only so the attention queue stops recomputing a
  penalty the admin has already reviewed. Waiver = revoked; ack = reviewed and upheld.
- **Flag** — kind(WATCHED / MISSED_CHECKOUT / TRIP_OVER_THRESHOLD), user?, branch?, context_json,
  **notified_at?** (an alert was sent) and **resolved_at?** (a human dealt with it: admin
  dismissed, or the employee punched and auto-cleared it). Keeping them separate matters —
  while they shared one column, the 23:30 sweep dropped flags nobody had reviewed, and
  dismissing one made `watchedDetector`'s dedup miss so the cron recreated it a minute later.
  `context_json` carries the detail the dashboard renders as the flag's reason.
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
  (remove/restore one auto-penalty; never touches adjustments) · `POST penalties/ack`
  (uphold one; clears it from the attention queue without changing pay).
- Flags: `POST flags/[id]/resolve`.
- Telegram: `GET telegram/code` (the 6-digit bind code + whether a bot/chat is configured).

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
- **Day-offs never block punching** — an approved DAY_OFF suppresses "absent" alerts and shows
  the person as off, but staff may still clock in to help during a rush.
- **Overnight shifts**: a schedule whose `end_time <= start_time` ends the **next day** (e.g.
  20:00 → 05:00). Handled everywhere — `missedCheckout` looks at yesterday's overnight + today's
  same-day shifts; penalties pair the closing OUT across midnight (late **and** early-leave both
  apply). Early-leave is only scored once the shift's scheduled end has passed.
- **Approved schedule changes sync everywhere**: an approved TIME_CHANGE (not just DAY_OFF) shifts
  the effective start/end used by penalties, `watchedDetector`, and `missedCheckout`, and shows in
  the admin schedule editor. Employees request DAY_OFF / TIME_CHANGE from the field app.
- **Correcting a punch clears its penalty**: penalties are computed from `punch.at` vs schedule,
  so an admin correcting a 09:45 IN to 09:00 makes the lateness zero → the penalty disappears
  automatically (no stored penalty to reverse).
- **Caller dispatch gate**: a driver can only go "out on order" (start a trip) after the caller
  rings them — the trip requires a `DriverCall` from the last 30 min with no trip yet; starting
  the trip consumes that call (`trip_id`). Prevents undispatched trips and ties each trip to its
  ring. Error `NOT_DISPATCHED` 409 if not rung. **A branch with no active CALLER cannot
  dispatch at all** — see the deploy checklist.
- **Fair driver rotation** (`compareForRotation` in `caller.ts`): the caller board orders
  available drivers by who went out **least recently**, so whoever just took an order sinks to
  the bottom. With 1, 2, 3 up and 2 dispatched, 2 returns to a board reading 1, 3, 2. A driver
  who has not been out at all outranks everyone. The caller can still ring anybody — this only
  makes the fair choice the obvious one so nobody slacks off.
- **Penalty review**: penalties apply automatically, so the admin queue is a *review* list, not
  an approval one. **Accept** upholds it (writes a `PenaltyAck`, changes no money); **Revoke**
  waives it (writes a `PenaltyWaiver`, returns the money) — for someone who did give notice,
  since the penalty targets people who ghost. Scoped to the last 7 days; older ones are a
  payroll-page matter.
- **Punch (`punch.ts`)** gate order: user active+branch → driver open-trip block →
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
  live per-employee status, weekly trends chart, **Needs attention**, activity feed, Telegram
  bind card) · `/admin/users` (Employees: branch filter, add/edit incl. name+username, rate,
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

### Needs attention (the admin's work queue)

Five row types. Every action reports what it changed — a row that merely vanishes is
indistinguishable from a button that does nothing, which is exactly how this failed before.

| Row | Actions | What they do |
|---|---|---|
| **Late** driver | none | Informational; clears itself when the driver presses Back. |
| **Flag** | Dismiss (+ Fix punch) | Dismiss is an acknowledgement only — no record changes. `MISSED_CHECKOUT` also links to `/admin/punches`, where the punch can actually be corrected. |
| **Penalty** | Accept · Revoke | Accept upholds (no money moves); Revoke waives and returns the money. |
| **Advance** | Approve · Reject | Approve deducts from this month's pay. |
| **Leave** | Approve · Reject | Approve writes `ScheduleOverride` rows — days off for `DAY_OFF`, **new hours for `TIME_CHANGE`**. The row shows the requested hours so the admin is not approving blind. |

Every irreversible action (Reject, Revoke) is **two-step**: the first tap arms the button,
the second commits. The decision endpoints answer `ALREADY_DECIDED` forever after, so a
misclick could not otherwise be undone.

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

**Caller ring** is fully shipped: a loud in-app alarm while the app is open **plus** Web Push
(`push.ts` + service worker + VAPID) so it also reaches a **locked/closed** phone — solid on
Android; iPhones must "Add to Home Screen" (install the PWA) on iOS 16.4+. Push is optional:
with no VAPID keys set it degrades to the in-app alarm only. Setup: see DEPLOY.md.

**Notifications** were audited end-to-end and repaired. What was wrong and is now fixed:
the web app could not reach Telegram at all (`punchEmployee` fell back to a hardcoded
`ConsoleNotifier`; both it and `requestAdvance` now resolve through `getNotifier()`); `punch.ts`
sent a `watched.resolved` key no template matched, rendering raw JSON; four templates deep-linked
to `/admin/flags` and `/admin/pending`, neither of which exists; `trip.over_threshold` always
printed "30 min" because the job never sent `threshold_min`; advance requests fired no alert;
`/start` advertised a `/help` that did not exist; and `resolveRecipient` opened a fresh
`PrismaClient` per message. **Security:** binding was open to anyone who found the bot — the
webhook secret proves a request came *from Telegram*, not *who* sent it — so `/start` now
requires a short-lived code shown only to a logged-in admin.

## 9. Known issues

One left:

1. **`driverStale` re-alerts every 30 min.** No per-trip guard, unlike `tripThreshold`'s
   `threshold_alerted_at`. A driver out 8h generates ~9 identical messages. → Add
   `stale_alerted_at` on `Trip` and gate on it.

*(The `Flag.notified_at` overload is fixed — `resolved_at` now exists. It had been causing
two visible bugs: dismissed flags reappearing within a minute, and the 23:30 sweep silently
clearing flags nobody had reviewed.)*

Minor / by design: `tripThreshold` sets `over_threshold` on the Trip but writes no
`TRIP_OVER_THRESHOLD` Flag — over-threshold trips reach the dashboard through the live
`lateDrivers` computation instead, so the enum value is written by nothing. Trips write no
separate AuditLog entry. The `end_of_day_watched` template is unreachable because
`endOfDayWatcher` sends `watched.unresolved` (which *is* handled) — dead code, not a bug.
