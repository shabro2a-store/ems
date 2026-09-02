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

**Which branch counts.** Normally only the employee's own. With
`can_roam_branches` the geofence is checked against **every active branch** and the
punch records the one they were actually standing at — so a shift can start at Hamra
and end at Achrafieh, and `/api/admin/now` files them where they really are. The
check itself never goes away: they must still be inside a real branch's radius with
acceptable GPS, which is what keeps a `BlockedPunchAttempt` (paid time) unforgeable.
A clock-**OUT** additionally always accepts the branch of the open check-in, whatever
the flag says now, so revoking the privilege mid-cover cannot strand somebody.

→ `200 { at, kind, minutes_since_in }`. Errors:
`OPEN_TRIP_EXISTS` 409, `ALREADY_PUNCHED_IN` 409, `NOT_PUNCHED_IN` 409,
`LOW_GPS_ACCURACY` 422, `OUT_OF_GEOFENCE` 422, plus the common ones. Every one
carries a message written for the employee's phone — the endpoint used to render
`Punch rejected: <CODE>` for all of them.

A check-in that meets a session left open from a shift-day that is over does NOT
fail: that session is closed at its scheduled hours and the punch goes through,
returning `system_closed_at` and a `notice` for the employee.

A **clock-out** is only overruled once the open session is past
`MAX_OPEN_SESSION_MIN`, and then returns `system_closed_instead_of_punch: true`
with no punch of theirs written. Below that the employee's own OUT is recorded
at `now`, however far past their scheduled hours it is - overruling them there
truncated real overtime and wrote a record saying they left earlier than they
did. See the asymmetry in SYSTEM_MAP §4.

`ALREADY_PUNCHED_IN` is therefore only reached by a duplicate tap on a live
session, and its message says to clock out first. It **records a
`BlockedPunchAttempt`** - the only rejection that does, because only this one
happens **after** the geofence check.

### POST /api/me/punch/dev  *(CSRF; dev only)*
Enabled only when `ENABLE_DEV_ENDPOINTS=true`, else `404`. Body `{ kind }`. Skips
GPS/geofence (uses the branch centre) for testing on devices without GPS. Its
`ALREADY_PUNCHED_IN` deliberately records **no** `BlockedPunchAttempt`: a blocked
attempt is paid time, and it is only sound evidence because the geofence ran first.

### GET /api/me/today
→ `200 { in_at, minutes_since_in, minutes_today, hours_month, open_session_stale }` — the field screens'
live counters. Hours only, no money: a shared shop floor with per-employee rates
made a live earnings ticker a source of friction. The caller's own payslip
(`GET /api/me/payroll`) still carries the real money figures.
- `minutes_since_in` is the **open session** alone, `null` when checked out — the
  driver's "On shift" tile.
- `minutes_today` is the whole **current shift-day** (`currentShiftDayMinutes`): every
  session that started on it, plus the open one counted to now. Punching out and back
  in adds to it instead of restarting it, and an overnight arrival keeps it climbing
  past midnight. This is what the tile labelled "Today" shows. It counts accepted
  blocked-time credit for that day, because `hours_month` does - the two used to
  disagree about the same day on the same screen.
- `open_session_stale` marks an open session past **MAX_OPEN_SESSION_MIN** - no longer
  a shift at all. Only then do the screens hide the clock-out button, show a warning and
  offer check-in instead. Deliberately NOT the check-in threshold: the screens derive
  `isIn` from this on a 30 second poll, so a night worker minutes past their grace would
  watch the button vanish mid-shift.

### GET /api/me/payroll?month=YYYY-MM
→ `200 { hours, gross_cent, blocked_credit_cent, blocked_credit_min, adjustments_cent,
advances_cent, penalties_cent, overtime_deduction_cent, net_cent }`. Every subtracted line is
listed separately, so `gross + adjustments − advances − penalties − overtime_deduction === net`.
`blocked_credit_cent` is **inside** `gross_cent` and inside `hours`, never added to either: it
is the accepted blocked-time credit, and without the line the payslip credits hours the
employee knows they did not clock.

### GET /api/me/advances  ·  GET /api/me/advances?view=list
Summary `{ pending, approved_balance_cent }`, or `{ advances: [...] }` (latest 50).

### POST /api/me/advances  *(CSRF, Idempotent, rate-limited)*
Body `{ amountCent, reason? }`. Capped at what's earned this month —
worked wages + bonuses − deductions − advances already approved this month.
→ `200 { id, status: "PENDING" }`. Error: `EXCEEDS_ACCRUED_EARNINGS` 409.

### GET /api/me/leave  ·  POST /api/me/leave  *(POST: CSRF, Idempotent)*
Summary `{ pending, upcoming: [...] }`; request body
`{ kind: "DAY_OFF"|"HOURS_CHANGE", start_date, end_date, hoursOff?, note? }`.
→ `200 { id, status: "PENDING" }`. Error: `PAST_DATE` 400.

### Driver trips (role DRIVER)
- **POST /api/me/trip/start** *(CSRF, Idempotent, rate-limited)* `{ lat, lng, accuracy }`
  Requires the driver to have been **rung by the caller** in the last 30 min (an unconsumed
  `DriverCall`); starting the trip consumes that ring. → `200 { trip_id, out_at }`. Errors:
  `NOT_DISPATCHED` 409 (no ring), `OPEN_TRIP_EXISTS` 409, geofence 422, `NOT_DRIVER` 403.
  The geofence is checked against **the branch that rang**, and the trip is filed there.
  Identical to the driver's own branch for anyone who cannot roam (`ringDriver` refuses a
  ring from elsewhere); for a driver covering at another branch it is what stops them
  collecting an order they were rung for while standing somewhere else.
- **POST /api/me/trip/end** *(CSRF, Idempotent)* `{ lat, lng, accuracy }`
  Geofenced against **the trip's own branch** — come back where you went out from.
  → `200 { trip_id, back_at, duration_min }`. Error: `NO_OPEN_TRIP` 409, which is now
  reachable without the driver doing anything wrong (the abandoned-trip sweep may have
  closed it), so it carries a message saying so.
- **GET /api/me/trip/current** → `200 { open, since_min?, threshold_min }`.

### GET /api/me/calls  ·  POST /api/me/calls/ack  *(ack: CSRF)*
Driver ring inbox. `GET` → `{ ringing: bool, since, canGoOut: bool }` — `ringing` is an
unacknowledged ring in the last 2 min (drives the alarm); `canGoOut` means a valid unconsumed
dispatch exists in the last 30 min (enables "out on order"). `POST /ack` marks all pending rings
acknowledged (dismiss the alarm).

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
  trips_today), attention{ lateDrivers, flags, penalties, overtime, blockedCredits,
  pendingAdvances, pendingLeaves } }`.
  - `penalties[]` — `{ user_id, username, date, kind: SHORTFALL, shortfallMin,
    penaltyMin, amount_cent, waived }`. Computed on the fly, last 7 days, excluding any day
    whose waiver or ack still names its current figure. `waived: true` marks a day whose
    removal has gone stale: **nothing is docked** for it, and it is here for a second look
    rather than a deduction. Resolved with `penalties/ack` (uphold) or `penalties/waive` (revoke).
  - `overtime[]` — `{ user_id, username, date, overtimeMin, amount_cent }`. Same
    on-the-fly computation and 7-day lookback as `penalties[]`; only days past the
    branch's shift grace with no *live* decision yet appear — a decision whose
    recorded minutes no longer match the day reads as pending and reappears here.
    Resolved with `overtime/decision` (see below).
  - `blockedCredits[]` — `{ user_id, username, date, blocked_at, credit_from_at,
    clocked_in_at, waitedMin, creditedMin, amount_cent }`. Time the app refused their
    check-in for while they stood at the branch. **Nothing is paid yet** — this is an approval
    queue, so `amount_cent` is what accepting would be worth. Same on-the-fly computation and
    7-day lookback; only days with no *live* decision appear. `waitedMin` above `creditedMin`
    means the cap trimmed it to the day's required hours; `credit_from_at` later than
    `blocked_at` means an earlier day's shift was still being paid past the attempt.
    Resolved with `blocked-credit/decision` (see below).
  - All three lists are loaded once per calendar month the 7-day lookback touches, so
    the window still reaches back over a month boundary. It matters most for
    overtime, where a day with no decision is already paid: a month-end overrun
    that never surfaced would auto-approve.
  - `people[].status` is `DAY_OFF` whenever the day resolves to **zero** required
    minutes — a `DAY_OFF` override, an `HOURS_CHANGE` override for the whole
    shift, or a weekday with no hours set — and only `ABSENT` when hours were
    owed and no punch exists. Same resolution payroll uses (`requiredMinFor`).
  - The day window comes from `todayInBeirutDateRange`, which resolves both ends from
    the calendar date. Deriving the end as `start + 24h` collapsed the range to nothing
    on Beirut's 25-hour fall-back day (2026-10-24) and lost an hour before the
    spring-forward — an empty window reads as "nobody worked".
  - `people[].hours_today` and `kpis.hoursToday` are the **current shift-day**, not
    today's calendar rows: a shift belongs to the Beirut day it started, so an
    employee who arrived at 21:00 stays present with a rising total past midnight
    (`currentShiftDayMinutes`). Punches are queried two days back so the previous
    day's arrival is visible; work that closed on an earlier shift-day is not
    counted towards this one. An open check-in older than 30h is treated as a forgotten
    checkout: it adds no minutes and the person is not `IN`, because `missedCheckout`
    flags such a punch but never closes it — the MISSED_CHECKOUT flag in `attention` is
    what reports it, not `hours_today` or `laborTodayCent`.
  - `pendingLeaves[]` includes `off_min` — an `HOURS_CHANGE` cannot be reviewed
    without the hours being requested.
  - `flags[]` includes a rendered **`reason`** built server-side from `context_json` —
    e.g. "No punch at all - they were scheduled 8h." for `WATCHED`, or "Still clocked
    in past their 8h shift, 1h 20m over. Overtime, or forgot to punch out?" for
    `MISSED_CHECKOUT`. Only unresolved flags appear (`resolved_at IS NULL`); being
    alerted about one does not remove it from the queue.
- **GET /api/admin/activity?branchId=&limit=** → `{ events: [{ id, type, username, at }] }`
  (punches + trips, newest first).
- **GET /api/admin/trends?branchId=&days=** → `{ points: [{ date, label, present, hours }] }`.
  The run of days comes from `beirutDateSeries`, and the query's lower bound from that run's
  first day — both calendar-derived, so no day is repeated or skipped either side of a DST
  change. Note this endpoint counts an open session up to `now` without the 30h
  forgotten-checkout clamp the dashboard applies, so the two can disagree; see the report.
- **GET /api/admin/now** → legacy presence snapshot `{ branches, flags }` (superseded by
  `overview`; kept only because integration tests still exercise it).

### Employees
- **GET /api/admin/users** → `{ users: [...] }` (no `password_hash`).
- **POST /api/admin/users** *(CSRF, Idempotent)* `{ username, name?, password, role:
  "EMPLOYEE"|"DRIVER"|"CALLER", branchId, hourlyRateCent, canRoamBranches? }` →
  `{ user, temp_password }`. `canRoamBranches` defaults to **false**: a new account is
  single-branch until the owner grants otherwise.
  `username` is the login; `name` is the display name. Creating an **ADMIN is
  rejected (403)**. **CALLER** needs a branch, gets no pay rate/RateChange, and is capped at
  **one active caller per branch** → `409 CALLER_EXISTS`.
- **PATCH /api/admin/users/[id]** *(CSRF)* `{ username?, name?, role?, branchId?,
  hourlyRateCent?, expectedMonthlySalaryCent?, canRoamBranches? }` (a rate change inserts a
  new `RateChange`;
  `username` is uniqueness-checked → `409 USERNAME_TAKEN`). Promoting to admin, or changing the
  admin's role, is **rejected (403)** (the admin's username/name are still editable).
  `expectedMonthlySalaryCent` (or `null` to clear) is a reference figure only — it is never
  read by any payroll calculation, just displayed on `/admin/payroll` next to actual earnings.
  `canRoamBranches` lets this person clock in and out at any active branch and be dispatched
  from whichever branch rang them; audited on both sides. Nothing about it is cached or
  copied onto a token, so revoking takes effect on the very next punch.
- **DELETE /api/admin/users/[id]** *(CSRF)* → `{ deleted, retired, username_freed?, history? }`.
  The person always goes; what varies is whether the ROW can. An account with nothing behind
  it is erased outright, along with its schedule, rate, overrides, leave requests, push
  subscriptions and flags. An account with records behind it is **retired**: `deleted_at` set,
  `is_active` false, password replaced with something unmatchable, telegram cleared, schedule
  and push subscriptions deleted, and the **username freed** (parked as `name#<id8>`) so the
  same person can be hired back under it with a genuinely new account. `name` keeps the human
  label. RateChange is kept — it is what prices their old punches.

  The row cannot go, because `Punch.user_id` is a required FK: Postgres would refuse, or a
  cascade would take a paid month's punches with it. Retiring gets the behaviour anyway —
  they vanish from every present-tense screen today, payroll for the months they worked still
  lists and pays them, and the month after they are simply absent because they have no
  arrivals in it. Nothing expires them and no job sweeps them up.

  Deleting the ADMIN account, or your own, is rejected 403. `GET /api/admin/users` excludes
  retired accounts entirely. The audit row outlives the person either way.
- **POST /api/admin/users/[id]/reset-password** *(CSRF)* optional `{ password }` —
  sets that password, or generates a random one. → `{ temp_password }`.
- **POST /api/admin/users/[id]/deactivate** *(CSRF)* toggles active. Deactivating an
  **admin is rejected (403)**.
- **PATCH /api/admin/users/[id]/notification-prefs** *(CSRF)* `{ dailySummary?, routinePings? }`.
- **GET /api/admin/schedules/[userId]** → `{ weeklySchedule, overrides, pendingLeaves }`.
- **PUT /api/admin/schedules/[userId]** *(CSRF)* `{ weeklySchedule: [{ weekday 0-6,
  shift_hours 0-24 }] }` (full replace).

### Branches
- **GET /api/admin/branches** → `{ branches: [...] }`.
- **POST /api/admin/branches** *(CSRF)* `{ name, lat?, lng?, gpsRadiusM?,
  gpsAccuracyMaxM?, shiftGraceMin?, tripThresholdMin? }` → `{ branch }`.
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
  `penalties_cent`, `overtime_deduction_cent`, `advances_cent`, `net_cent` — every
  line `net_cent` is built from, so the table reconciles. Rows also carry
  `blocked_credit_cent` / `blocked_credit_min` (and `totals` the cent figure): a memo line
  **inside** `gross_cent`, never added to it — accepted blocked-time credit, shown so a
  gross figure containing hours nobody clocked says so. Each row also carries
  `expected_salary_cent` (nullable) — the owner's reference figure; deliberately absent
  from `totals`, since it is never summed or built into `net_cent`.
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
Shortfall penalties are **computed** from hours owed vs hours covered, not stored:
past the branch's `shift_grace_min` the docked minutes are `min(2 × shortfallMin,
workedMin)` and the amount is `floor(penaltyMin × rate / 60)` **clamped to that day's
own gross**, priced the way payroll prices it (per IN/OUT interval, at the rate in
force when each closed). So `amount_cent` is not always `penaltyMin × rate_cent`, and
the screens do not present it as an equation. A day whose rate resolves to zero — a punch
backdated to before the employee's first `RateChange` — grosses zero, so its penalty is
zero and **the day is omitted entirely**: a $0.00 penalty is not something the owner can
accept or revoke. The grace is a
threshold, not forgiveness — the whole shortfall is doubled once it is crossed —
and the ceiling at the day's own worked minutes means a penalty can zero a day's
pay but never reach into another day's. They surface in payroll as
`penalties_cent` and reduce `net_cent`.
A day is only judged once it is over: the employee's **current shift-day** (the
Beirut day of their open check-in, else today) never appears, so a split shift
raises no shortfall between its sessions. Unclosed days stay out too.
- **GET /api/admin/penalties?userId=&month=YYYY-MM** → `{ penalties: [{ date, kind:
  "SHORTFALL", shortfallMin, penaltyMin, rate_cent, amount_cent, waived, waiverStale }] }`.
  `waived` is the money (a waiver row exists, so nothing is docked); `waiverStale` says that
  row named a different figure and the day wants a second look.
- **POST /api/admin/penalties/waive** *(CSRF)* `{ userId, date: "YYYY-MM-DD", kind:
  "SHORTFALL", waived: bool, penaltyMin, reason? }` — removes (`waived:true`) or
  re-applies (`waived:false`) one auto-penalty. Only ever writes `PenaltyWaiver`
  rows; never a manual adjustment. → `{ waived }`.
- **POST /api/admin/penalties/ack** *(CSRF)* `{ userId, date: "YYYY-MM-DD", kind:
  "SHORTFALL", penaltyMin }` — upholds one auto-penalty: writes a `PenaltyAck` so the
  attention queue stops recomputing it. **Changes no money** — `waive` is the one
  that refunds. Audited. → `{ acknowledged: true }`.
  `ack` also **deletes any waiver** for that day — "this penalty stands" is the opposite
  of "this penalty is removed" — in one transaction with the ack and an audit entry whose
  `before` carries the deleted waiver's figure, reason, author and timestamp. (`waive`
  does not clear an ack; a stale ack behind a live waiver is inert, since the waiver is
  read first.)
- `penaltyMin` is **required** on both and must be **at least 1**: it is the amount the
  screen was showing, and a day with nothing docked is not a day that can be ruled on.
  (`penaltyMinForDay` answers 0 for such a day, so a body of 0 would otherwise match and
  land a ruling nobody could see.) The
  route computes the day's true docked minutes **server-side** and compares. They must
  match — otherwise `409 PENALTY_CHANGED`, naming both figures, and **nothing is
  written**. A refusal deletes nothing either, so an existing waiver keeps suppressing
  the penalty across it: the check can never be what starts a deduction. On a match the
  row is stamped with the **server's** value, so the body never supplies money.
- If the day's penalty changes *after* a ruling, that ruling goes stale, and staleness
  decides **review, not money**: the day reappears on the attention queue at the new
  amount. A stale **ack** stops suppressing the notice (the penalty was applying all
  along); a stale **waiver** goes on forgiving — `waived` stays true and nothing is
  docked — because dropping it would take back money the owner had already given, on an
  amount he has never seen. A null `penalty_min` (any row predating the column) is
  unreviewed the same way, so no forgiven day is re-docked by the deploy.

### Overtime
`amount_cent` on an overtime day is what the excess minutes were **actually paid** (the
last `overtimeMin` minutes, priced per interval), not `overtimeMin × one rate` — so a
revoke after a mid-shift raise takes back the excess and leaves the required hours intact.

A day that ran past its required hours by more than the branch's shift grace
is **computed**, not stored, until the owner decides it (see `overtimeForUser`).
A pending day (no decision) is already paid — pairHours pays every worked minute —
so it surfaces in payroll only if revoked.
- **GET /api/admin/overtime?userId=&month=YYYY-MM** → `{ overtime: [{ date,
  overtimeMin, rate_cent, amount_cent, decision: "ACCEPTED"|"REVOKED"|null }] }`.
  Unlike the attention queue this keeps **decided** days, which is what makes a
  decision reversible — the queue drops a day the moment it has one.
- **POST /api/admin/overtime/decision** *(CSRF, Idempotent)* `{ userId, date:
  "YYYY-MM-DD", decision: "ACCEPTED"|"REVOKED"|"PENDING", overtimeMin, reason? }` — upserts the
  one `OvertimeDecision` row for that (user, date). `ACCEPTED` **changes no money**
  and only takes the notice off the attention queue; `REVOKED` makes payroll
  subtract that day's excess. `PENDING` is the undo: it is not an
  `OvertimeDecisionKind` — the absence of a row *is* pending — so it **deletes** the
  row, returning the day to the queue and the money to the employee. Audited as
  `overtime.accepted` / `overtime.revoked` / `overtime.undecided`. → `{ decision }`.
  `overtimeMin` is **required** for `ACCEPTED`/`REVOKED` (not for `PENDING`, which only
  hands money back): it is the amount the screen was showing. The route computes the day's
  true current overtime **server-side** and compares. They must match — otherwise
  `409 OVERTIME_CHANGED`, naming both figures, and **nothing is written**. On a match the
  row is stamped with the **server's** value, so the body never supplies money; the client's
  number is only ever a comparison token. Without this a punch landing while the payroll
  overtime modal sat open (it does not poll) turned a click on a `$4.00` row into a `$10.00`
  deduction. If the day's overtime changes *after* a decision, that decision goes stale:
  `decision` reads `null` everywhere, the day returns to the attention queue at the new
  amount, and nothing is deducted until the owner rules again.

### Blocked-time credit
- **POST /api/admin/blocked-credit/decision** *(CSRF, Idempotent)* `{ userId, date:
  "YYYY-MM-DD", decision: "ACCEPTED"|"REVOKED"|"PENDING", creditedMin, reason? }` — upserts the
  one `BlockedCreditDecision` row for that (user, date). Credit grants nothing until it is
  accepted, so this is an approval rather than a review: `ACCEPTED` is what puts the minutes
  into gross and clears that day's shortfall; `REVOKED` **changes no money at all** and only
  clears the notice. Note the inversion against overtime, where the pending day is the paid
  one. `PENDING` is the undo for either: the absence of a row *is* pending, so it **deletes**
  the row and the day returns to the queue uncredited. Audited as
  `blocked_credit.accepted` / `.revoked` / `.undecided`. → `{ decision }`.
  `creditedMin` is **required** for `ACCEPTED`/`REVOKED` (not for `PENDING`, which only hands
  money back): it is the amount the screen was showing. The route recomputes the day's true
  credit server-side and compares — mismatch is `409 CREDIT_CHANGED`, naming both figures, and
  **nothing is written**. On a match the row stores the **server's** value. A day with no
  credit at all cannot be ruled on (`400 INVALID_INPUT`), because a ruling stamped with 0 would
  match every future 0 and quietly cover whatever the day grows into. A ruling goes stale the
  moment its `credited_min` stops matching, and a stale ruling reads as pending — so the credit
  is **withheld** and the day returns to the queue. The same mechanic as overtime, opposite
  effect, and deliberately: the cap sizes credit to fill the day, so a corrected punch could
  otherwise turn an approved 30 minutes into an approved eight hours.

### Flags
- **POST /api/admin/flags/[id]/resolve** *(CSRF)* — acknowledges a flag
  (sets `notified_at`); audited. Changes no punch or pay record. → `{ id, resolved_at }`.

### Telegram binding
- **GET /api/admin/telegram/code** → `{ bound, bot_configured, webhook_secret_ok, bind_url }`.
  `bind_url` is `https://t.me/<bot>`; the owner sends it to whoever holds the work phone, who
  presses START. There is no code and nothing expires - the manager carrying the handset has
  no login here, so anything that had to be read off the dashboard could not be used. Null
  when the bot username cannot be resolved (no token, or `getMe` failed). `webhook_secret_ok`
  is false while `TELEGRAM_WEBHOOK_SECRET` is unset or still the literal `docker-compose.yml`
  falls back to, which is committed to this repo - from outside, that state is
  indistinguishable from a correct one and would never fail on its own.
- **POST /api/admin/telegram/test** *(CSRF)* → `{ delivered }`, and on failure
  `{ delivered: false, reason, message }` where `reason` is `NOT_BOUND`, `NO_TOKEN` or
  `TELEGRAM_ERROR`. Sends a real message to the chat **the notifier resolves**, not to the
  caller's own row — a test that proves a different chat works is worse than no test.
  `bot_configured` and `bound` only say a token and a chat id exist; a token typed one
  character short, a blocked bot, or a chat lost to a reinstall all read as connected and
  deliver nothing. This is the only thing that proves delivery.
- **POST /api/admin/telegram/disconnect** *(CSRF)* → `{ was_bound, cleared }`. Clears the
  binding on **every** admin account and best-effort tells each chat it was cut off;
  audited as `telegram.disconnect` per row. All accounts, not just the caller's, because
  the button promises alerts stop — a disconnect that leaves the notifier resolving another
  admin's chat is the worst outcome available. Re-binding costs one code.

---

## Caller (`/api/caller/*`, role CALLER)

The POS caller's board. A caller belongs to one branch and can only see/ring drivers there.

### GET /api/caller/drivers
→ `{ branch, drivers: [{ id, username, name, clocked_in, available, open_trip_since,
trips_today, ringing, last_trip_at, roaming }] }`. `available` = clocked in and not on a trip;
`roaming` = belongs to another branch and is covering here. A visiting driver appears on
exactly one board — the branch their open check-in was made at — and sorts behind the
branch's own drivers at equal availability;
`trips_today` counts trips since this shift's clock-in.

**Order is meaningful — the board renders it as-is.** Available drivers come first, then
those out on an order, then off-shift. Within the available group, the driver who went out
**least recently** is first (`last_trip_at` ascending, never-dispatched first), so whoever
just took an order sinks to the bottom and everyone gets a turn. The caller may still ring
anyone.

### POST /api/caller/ring  *(CSRF)*
Body `{ driverId }`. Records a ring the driver's app picks up. → `{ rang: true }`.
Errors: `WRONG_BRANCH` 403, `NOT_FOUND` 404. A driver from another branch may be rung only
while `can_roam_branches` **and** their open check-in is at this branch — roaming alone is
not enough, since the ring is what authorises the trip.

## Telegram

### POST /api/telegram/webhook (public, secret-guarded)
Guarded by the `x-telegram-bot-api-secret-token` header vs `TELEGRAM_WEBHOOK_SECRET`, and
**fails closed**: once `TELEGRAM_BOT_TOKEN` is set, a missing or mismatched secret is a 403.
It used to skip the check entirely when the variable was empty — the one shape of mistake
where forgetting to set something removes a guard rather than breaking loudly. With no bot
token configured there is nothing to guard and the endpoint still answers.
That header proves the request came **from Telegram**, not *who* messaged the bot, so
binding is additionally gated on a code from `GET /api/admin/telegram/code`:

- `/start` from a chat when nothing is bound → binds it. `200 { bound }`
- `/start` from the chat already bound → `200 { alreadyBound: true }`
- `/start` from a different chat while one is bound → `200 { rejected: 'already_bound' }`,
  and the reply points at Disconnect. **First come, and only that.** An open bind that let
  any later `/start` take over would let another chat silently replace the work phone: the
  owner would just stop receiving alerts with nothing anywhere to say why.
- `/stop` from the bound chat → unbinds it. `200 { stopped: true }`. The same thing
  Disconnect does, for the person holding the handset rather than the one holding the login.
- `/help` → `200 { helped: true }`
- anything else → `200 { skipped: true }` (ack so Telegram stops retrying)

Always `200` on handled updates — a non-2xx makes Telegram retry the same update.
