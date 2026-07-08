# Employee Management System — PRD
**Client:** [Supermarket name] — 3 branches, Beirut
**Provider:** Kyvera Agency
**Version:** 2.0 — July 2026 (as agreed)

---

## 1. Overview

A mobile-first web application (PWA) that manages employee attendance, live earnings, salary advances, and delivery-driver round-trips across 3 supermarket branches. Check-in and check-out are locked to physical presence at a branch via GPS geofencing (50m radius). The owner (single admin) manages everything from one dashboard and receives real-time alerts on his phone. UI is English-only, built around large color-coded buttons for floor staff.

**Design principle:** The system records honestly and flags anomalies. Enforcement stays human (owner, cameras, managers). No continuous location tracking of anyone, ever — location is checked only at the moment a button is pressed.

---

## 2. Users & Roles

| Role | Count | Access |
|---|---|---|
| **Admin (Owner)** | 1 | Full dashboard, all branches, all approvals, user management |
| **Employee** | ~all staff | Check-in/out, own hours & earnings, advance requests |
| **Driver** | subset of employees | Everything an employee has + delivery out/back buttons |

- Only the admin can create, deactivate, or edit users. (Deactivate, never delete — payroll history is preserved.)
- Employees log in with username + password from their own phones.
- Login works from anywhere (to view hours/earnings, request advances). Only **check-in/out and driver buttons** are geofence-locked.

---

## 3. Employee Features

### 3.1 Geofenced Check-In / Check-Out
- One big button. Enabled only when the phone's GPS places the employee within **50m of any branch** (radius configurable per branch).
- Distance calculated **server-side** (haversine against stored branch coordinates). No Google Maps API required.
- Punch is tagged to the branch it happened at.
- Every punch logs: timestamp, coordinates, GPS accuracy, device fingerprint, IP — visible to admin for anomaly review.
- Low GPS accuracy → "move near a window / outside and retry" message, not a silent failure.
- Missed checkout → auto-closed at branch closing time and flagged for admin review.

### 3.2 Live Earnings
- While checked in, the employee sees a live counter: **hours today, earned today, earned this month, advances deducted, net so far**.
- Based on per-employee hourly rate set by admin. Rate history is stored — changing a rate never rewrites past earnings.

### 3.3 Salary Advance (سلفة) Requests
- Employee submits amount + optional reason, from anywhere.
- Status flow: **pending → approved / dismissed → paid**.
- Approved advances automatically deduct from the monthly payout calculation.
- Employee sees their full advance history and current balance.

---

## 4. Driver Features

Round-trip timer — measures time away from the store, not location:

- **"Out on delivery"** button (tap when leaving, geofence-validated) → timer starts. Optional: number of orders in this trip.
- **"Back"** button — **only works inside the branch geofence**, so return is proven physical presence.
- Trip exceeds threshold (default 30 min, configurable) → instant alert to owner: *"[Driver] out 34 min and counting."*
- Persistent "you are marked out" banner on the driver's screen; shift checkout auto-closes any open trip (flagged).
- Admin sees per driver: trips/day, minutes per trip, total time out vs. shift time, % over threshold.
- **No GPS during the ride. No route tracking. Location is read only at the two button presses.**

---

## 5. Schedules & Automatic Flags

- Admin sets a weekly schedule per employee (with date-specific overrides for swaps/holidays).
- Schedules **inform, never block** — early or late check-ins are always allowed, but flagged.
- Automatic flags, all pushed as notifications and visible in the dashboard:
  - 🔴 Late check-in (vs. scheduled start)
  - 🔴 Absent (no punch X min after scheduled start)
  - 🟠 Early checkout
  - 🟠 Overtime (checkout well past scheduled end)
  - 🟠 Missed checkout (auto-closed)
  - 🟠 Driver trip over threshold
  - ⚠️ Punch from a new/unusual device

---

## 6. Admin Dashboard (Owner)

"Log in and find ready numbers" — answers, not raw data.

### 6.1 Main Screen
- **Now:** who is checked in per branch, who is late/absent, drivers currently out (live minutes).
- **Pending:** advance requests — approve/dismiss inline.
- **This month:** per employee — hours, earned, advances, adjustments, **projected payout** (hours × rate + adjustments − advances). Per branch totals. Filters by branch/employee/date range. Export.
- **Flags feed:** all anomalies, newest first.

### 6.2 Management Screens
- Users: create / deactivate / edit, assign role (employee/driver) and branch, set hourly rate.
- **Bonus / deduction (top-up):** admin adds a salary adjustment (+/−) with reason — full ledger, every entry logged (who, when, what, why).
- Schedules: weekly grid editor per employee.
- Punch correction: admin can fix punches manually — every correction recorded in an audit log.
- Branches: set/adjust geofence pin and radius per branch.
- Notification settings: choose which events ping (exceptions-only by default) + optional daily closing summary.

### 6.3 Reports (PDF)
- One-click generated PDF reports: monthly payroll (per employee: hours, gross, adjustments, advances, net payout), attendance per branch, advances ledger, driver statistics.
- PDFs are read-only by nature — printable, shareable, and tamper-proof. The system's numbers remain the only version of the records.

---

## 7. Notifications

- **Telegram bot:** free, instant, reliable. Owner receives all flags and requests as push messages. **Inline approve/dismiss buttons** for advances — no dashboard needed for daily operations.
- Exceptions-only by default so the channel never gets muted; optional daily closing summary.
- Notification layer is channel-agnostic — WhatsApp can be added later as a separate upgrade.

---

## 8. Technical Summary

| Layer | Choice |
|---|---|
| App | Next.js, mobile-first **PWA** (Add to Home Screen, app-like), English UI, large color-coded buttons |
| Auth | Username/password (bcrypt), JWT sessions, role-based access |
| Database | PostgreSQL (Prisma) — users, branches, punches, schedules, advances, adjustments, trips, audit log, rate history |
| Geofence | Server-side haversine vs. stored branch coordinates — zero external API cost |
| Alerts | Telegram Bot API behind a channel-agnostic notify layer |
| Background jobs | Cron checks (late/absent detection, trip thresholds, auto-checkout) — no continuous processes |
| Hosting | Coolify on Hetzner VPS, Cloudflare (DNS/SSL/protection), custom domain |
| Scale | Branches are configuration rows — adding branch #4+ requires no code changes |

---

## 9. Data Safety

- **Single source of truth:** PostgreSQL, never exposed to the public internet (internal Docker network only).
- **Daily backups:** full database backup every night, encrypted and stored in **two locations** (on-server + off-server Google Drive). Retention: 7 daily + 4 weekly + 3 monthly snapshots, with automatic success/failure alerts.
- **Audit trail:** every manual punch correction, salary adjustment, and advance decision is permanently logged (who, when, what changed).
- Restore procedure tested before launch.

---

## 10. Timeline

| Phase | Duration |
|---|---|
| Build (backend-first, then UI) | **~1 month** |
| Testing — on-site field testing + pilot at one branch | **up to 1 month** |
| Rollout to all 3 branches | 1 day |

Testing includes developer on-site sessions at branches (agreed), a quiet field test with a few registered employees, then a live pilot at one branch. Pilot exit rule: no payroll-affecting bugs → full rollout. Delivery moves faster if testing goes clean — quality is never traded for speed.

---

## 11. Commercial Terms

- **$1,500** — full build + first year included (hosting, backups, security updates, bug fixes). **Agreed.**
- **$500/year** from year two — covers the **current setup (3 branches)**. **Agreed.**
- Deposit: **$750 — Wednesday** (build clock starts on receipt).
- New features, new modules, and additional branches are scoped and priced separately.

---

## 12. Out of Scope (v1)

Explicitly not included — available as future paid additions:
- Payroll payment execution (system calculates payouts; paying is manual)
- POS / inventory integration
- Route/live GPS tracking of any kind
- Native iOS/Android apps (PWA covers the need)
- Multiple admin accounts / manager roles
- Fingerprint or biometric hardware
- WhatsApp notifications (future paid add-on — Telegram covers all alerts in v1)
