# Build Plan — Supermarket EMS

**Project:** Employee Management System (Supermarket, 3 branches, Beirut)
**Provider:** Kyvera Agency
**Document version:** v1.0
**Source of truth:** `spec.md` — this file is a **phased execution plan** derived from it.
**Goal:** Break the system into phases an agent can execute one at a time. Each phase has: scope, files to touch, prompts to feed the build session, verification, and exit criteria.

---

## How to use this document

1. **Read this file top-to-bottom first.** It tells you the order.
2. **For each phase**, read the linked sections of `spec.md` BEFORE generating the build prompt.
3. **Generate a build prompt** for the session using the phase's "Build prompt template" + phase scope.
4. **Generate a verification prompt** using the phase's "Verify prompt template" + phase scope after the build completes.
5. **Don't move to the next phase** until the exit criteria pass.

**Authority hierarchy** (same as `spec.md`): the data model (`spec.md` §6), endpoints (`spec.md` §7), services (`spec.md` §8), and security (`spec.md` §9) win over anything else. If a phase description below conflicts with `spec.md`, `spec.md` wins.

**Canonical decision rule when `build.md` and `spec.md` disagree:**

| Conflict type | Winner | Example |
|---|---|---|
| Schema (tables, fields, types, constraints, comments documenting pending migrations) | `spec.md` §6 | Phase 0: schema file must include the CHECK constraint comments even though the raw-SQL migration is Phase 1's job |
| Endpoints (path, method, body shape, response shape, auth) | `spec.md` §7 | Phase 5a must implement `/api/admin/users/:id/reset-password` returning `{ temp_password }` |
| Service logic (payout, geofence, watched-flag resolution) | `spec.md` §8 | Phase 2.5 payout must read only from `RateChange`, not `User.hourly_rate_cent` |
| Security (cookies, CSRF, rate limits, bcrypt rounds) | `spec.md` §9 | Login CSRF-exempt rule applies regardless of which phase builds login |
| **Build order, phase scope, file naming, commit format** | `build.md` | Phase 5 split into 5a/5b; payout built in 2.5 not 3 |
| **New tables/fields/endpoints not in either doc** | Neither — STOP | Update both docs first, then proceed |

**When in doubt: `spec.md` for WHAT, `build.md` for WHEN and HOW.**

---

## Phase overview

| Phase | Title | Duration estimate | Depends on |
|---|---|---|---|
| **0** | Local infra & repo bootstrap | ~2 hours | Nothing |
| **1** | Auth + DB foundation + seed | ~2 days | Phase 0 |
| **2** | Punch + Geofence + Employee PWA | ~3 days | Phase 1 |
| **2.5** | **Staging deploy + money functions (tests-first)** | ~2 days | Phase 2 |
| **3** | Advances + Adjustments + Audit endpoints & UI | ~3 days | Phase 2.5 |
| **4** | Driver trips + Schedule + Leave + Flags | ~4 days | Phase 3 |
| **5a** | Admin Dashboard UI | ~3 days | Phase 4 |
| **5b** | Telegram + PDF + notification templates | ~2 days | Phase 5a |
| **6** | Polish + PWA + Observability + Backups | ~3 days | Phase 5b |
| **7** | Field testing & pilot | ~2 weeks | Phase 6 |
| **8** | Bug fixes from field testing | as needed | Phase 7 |

**Total realistic build:** ~3.5 weeks of focused work (not the 6 weeks in `spec.md` §10 — that includes buffer, polish pauses, and the inevitable "wait, why doesn't this work" debugging days). Build can run in parallel with VPS preparation.

**Pure functions are built first.** `lib/time.ts`, `lib/geofence.ts`, and `lib/services/payout.ts` are the most consequential math in the system. They are built in **Phase 2.5** before any endpoint wires to them, with their Vitest suites written before the implementation (TDD red-green). This catches DST edge cases, haversine off-by-ones, and rate-history bugs at the unit level — not in the dashboard.

---

## Phase 0 — Local infra & repo bootstrap

**Goal:** A runnable monorepo on the developer's Windows machine with a local Postgres, able to start the web and worker processes.

### Files to create

```
/
  package.json                  # root, pnpm workspace
  pnpm-workspace.yaml
  docker-compose.yml            # web, worker, db (local)
  .env.example
  .gitignore
  README.md                     # how to run locally
  AGENTS.md                     # conventions for build agents
  apps/
    web/
      package.json
      next.config.js
      tsconfig.json
      tailwind.config.ts
      postcss.config.js
      Dockerfile
      public/
        manifest.json
        sw.js                   # minimal service worker stub
      middleware.ts             # stub for now (returns next())
    worker/
      package.json
      tsconfig.json
      Dockerfile
      src/
        index.ts                # main entry, starts cron jobs
  packages/
    db/
      package.json
      prisma/
        schema.prisma           # COPY FROM spec.md §6 VERBATIM
        seed.ts                 # admin + 3 branches + sample employees
      tsconfig.json
    notify/
      package.json
      src/
        types.ts                # Notifier interface
        console.ts              # ConsoleNotifier (dev)
        index.ts                # factory
      tsconfig.json
    pdf/
      package.json              # empty placeholder for now
      tsconfig.json
    time/
      package.json
      src/
        index.ts                # lib/time.ts per spec.md §5
      tsconfig.json
  scripts/
    backup.sh                   # placeholder (implemented in Phase 6)
    restore.sh                  # placeholder
```

### Decisions baked in (from spec.md)

- pnpm workspaces, not turborepo (one less moving part for v1).
- Tailwind config: `min-h-12` default button height (≥56px tap targets).
- Prisma schema: **copy verbatim from `spec.md` §6**. Do not improvise.
- `lib/time.ts`: pin `date-fns-tz@^2.0.0`. See `spec.md` §5 for the API names.
- Two raw-SQL migration files needed: one for partial unique index on `Trip`, one for CHECK constraints + `REVOKE`. Stub these in this phase; populate in Phase 1.

### Build prompt template (paste into session)

```
You are building Phase 0 of the Supermarket EMS project. Read these files in order:
1. /spec.md  (full document)
2. /build.md (this file, just the Phase 0 section)
3. /AGENTS.md (conventions)

Your task: scaffold the monorepo exactly as described in build.md Phase 0 "Files to create".
DO NOT implement any business logic yet. The goal is "pnpm install && docker compose up" works and
the empty web app serves localhost:3000 with a "Hello EMS" placeholder.

CRITICAL CONSTRAINTS:
- The Prisma schema in packages/db/prisma/schema.prisma must be COPIED VERBATIM from spec.md §6.
  Do not add or remove fields. Do not "improve" the relations.
- lib/time.ts in packages/time/src/index.ts must use date-fns-tz@^2.0.0 (NOT v3 — v3 renamed
  zonedTimeToUtc to fromZonedTime).
- All TypeScript files must pass `pnpm typecheck` with no errors.
- Docker compose must have services: web, worker, db (postgres:16).
- Web app is Next.js 14 App Router (NOT pages router).
- No business logic. No API routes. No pages beyond a placeholder.
- Commit with message "phase-0: monorepo bootstrap".

When done, output:
- `pnpm install` exit code
- `docker compose up -d db` exit code
- `pnpm --filter db prisma generate` exit code (schema valid)
- `pnpm --filter web dev` startup log (port 3000, "Hello EMS")
```

### Verify prompt template

```
You are verifying Phase 0 of the Supermarket EMS. The build session claims to have completed it.
Read /spec.md and /build.md (Phase 0 section), then:

1. `cd` to repo root.
2. Run `pnpm install` and confirm it exits 0.
3. Run `docker compose up -d db` and confirm Postgres is healthy (docker ps shows healthy).
4. Run `pnpm --filter db prisma generate` and confirm exit 0.
5. Run `pnpm --filter db prisma validate` and confirm exit 0.
6. Run `pnpm --filter web dev` (background). Wait 10s. Curl localhost:3000 and confirm 200.
7. Run `pnpm --filter worker dev` (background). Wait 5s. Confirm stdout shows "cron runner started".
8. Diff packages/db/prisma/schema.prisma against spec.md §6. Report any deviations.

DO NOT proceed to Phase 1 verification until all 8 pass. Report any deviation as a FAIL with
the diff line.
```

### Exit criteria

- [ ] `pnpm install` clean
- [ ] Postgres healthy in Docker
- [ ] Prisma schema validates and matches `spec.md` §6 verbatim
- [ ] Web serves localhost:3000
- [ ] Worker starts without crashing
- [ ] Git initialized, first commit on `main`

---

## Phase 1 — Auth + DB foundation + seed

**Goal:** A user can log in as admin, see a placeholder dashboard, and log out. Seed creates the admin + 3 branches + sample employees.

**Spec sections to read first:** `spec.md` §3.4 (Auth), §4.7 (Authorization), §6 (Schema), §9 (Security), §10.2 Week 1.

### Scope (what to build)

1. **`apps/web/app/api/auth/login/route.ts`** — POST `{ username, password }` → bcrypt verify → issue JWT cookies (access + csrf).
2. **`apps/web/app/api/auth/logout/route.ts`** — POST → clear cookies.
3. **`apps/web/app/api/auth/refresh/route.ts`** — POST → issue new access token.
4. **`apps/web/middleware.ts`** — decode JWT, attach userId/role/branchId to request headers. Reject unauthenticated requests to `/api/me/*` and `/api/admin/*`.
5. **`apps/web/lib/auth/session.ts`** — implements `sessionExpiryFor()` per `spec.md` §8.1.
6. **`apps/web/lib/auth/jwt.ts`** — sign/verify JWT. Access token TTL: 2h for employees, dynamic for drivers per `spec.md` §8.1.
7. **`apps/web/lib/auth/csrf.ts`** — generate/validate CSRF token (double-submit cookie pattern per `spec.md` §9).
8. **`apps/web/lib/auth/password.ts`** — `bcrypt(password, 12)`, `bcrypt.compare`.
9. **`apps/web/lib/db/prisma.ts`** — singleton Prisma client (handles dev hot-reload).
10. **`apps/web/app/(public)/login/page.tsx`** — login form (username, password).
11. **`apps/web/app/(app)/admin/page.tsx`** — placeholder "Dashboard coming in Phase 5a".
12. **`apps/web/app/(app)/employee/page.tsx`** — placeholder "Employee home coming in Phase 2".
13. **`packages/db/prisma/seed.ts`** — seeds admin (`owner/change-me`), 3 branches with real Beirut coords (per `spec.md` §12), 1 sample employee per branch with schedule + initial `RateChange` row (CRITICAL — every user creation must write a `RateChange` row, see `spec.md` §8.3).
14. **Raw-SQL migration** for: CHECK constraints (weekday range, time format, period = 1st, amount ≥ 0, leave range), partial unique on Trip, partial index for `/api/admin/now`, `REVOKE UPDATE, DELETE ON audit_log FROM ems_app`.
15. **`AGENTS.md`** — write conventions (no emoji in code, no comments unless asked, TypeScript strict, pnpm only, etc.).

### Tests to write

- `lib/auth/session.test.ts` — covers `sessionExpiryFor` for employee/driver with schedule/driver without schedule (decision #34)/driver with cross-midnight shift (decision #36).
- `lib/auth/password.test.ts` — bcrypt round-trip.
- `lib/auth/csrf.test.ts` — generate + validate.
- `lib/auth/jwt.test.ts` — sign + verify + expiry.

### Build prompt template

```
You are building Phase 1 of the Supermarket EMS project. Read these files in order:
1. /spec.md  (full document)
2. /build.md (Phase 1 section)
3. /AGENTS.md (conventions)
4. /packages/db/prisma/schema.prisma (already created in Phase 0)

Your task: implement authentication, the seed script, and the raw-SQL migration. See build.md
Phase 1 "Scope" for the file list.

CRITICAL CONSTRAINTS:
- Every user creation (including in seed.ts) MUST write a RateChange row in the SAME transaction.
  Read spec.md §8.3 "Single source of truth for rate" — this is non-negotiable.
- bcrypt rounds = 12 (spec.md §9).
- Session expiry logic: read spec.md §8.1. Test cross-midnight shifts.
- CSRF: double-submit cookie pattern, exempt /api/auth/login and /api/telegram/webhook.
- Login route is EXCLUDED from idempotency (spec.md §4.2).
- Login rate limit identifier format: `login:{username}:{ip}` — works for non-existent usernames too.
- Cookie attributes: Secure; HttpOnly; SameSite=Lax; Path=/.
- middleware.ts must attach userId/role/branchId headers for downstream handlers.
- seed.ts uses real Beirut coords from spec.md §12 (Hamra, Achrafieh, Verdun).
- Admin password on first seed is "change-me". User MUST be forced to change on first login (add
  this to the login response as a flag, render a "change password" page in Phase 5a — for now just
  return `{ ok: true, data: { ..., mustChangePassword: true } }`).
- Raw-SQL migration: write a separate file at packages/db/prisma/migrations/<timestamp>_constraints/
  migration.sql containing all CHECK constraints + partial unique index on Trip + REVOKE statement.

DO NOT implement business logic beyond login. Punch endpoints are Phase 2.

Commit with message "phase-1: auth + seed".
```

### Verify prompt template

```
You are verifying Phase 1. Read /spec.md and /build.md (Phase 1).

1. `pnpm test` and confirm ALL auth tests pass (session, password, csrf, jwt).
2. `pnpm --filter db prisma migrate dev --name phase-1-constraints` and confirm exit 0.
3. `psql` to local DB, verify CHECK constraints exist:
   - `SELECT conname FROM pg_constraint WHERE conname LIKE '%chk%'` should list all CHECK constraints.
   - Verify REVOKE: connect as the app user and try `UPDATE audit_log SET ...` — should fail.
4. `pnpm --filter db prisma db seed` and confirm 1 admin + 3 branches + 3 employees created.
5. `psql` and verify: `SELECT COUNT(*) FROM "RateChange"` should be exactly **3** (admin gets no RateChange row — admins don't punch; the invariant is "every non-admin user creation writes a RateChange in the same transaction", spec.md §8.3).
6. Start web. curl POST /api/auth/login with `{"username":"owner","password":"change-me"}`. Confirm 200 + Set-Cookie headers.
7. With cookies, curl GET /api/me/anything. Confirm middleware attaches userId header (use --verbose).
8. Logout. Confirm cookies cleared.
9. Try login with wrong password 6 times. Confirm 6th attempt returns 429 (rate limit).

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All auth tests pass
- [ ] Raw-SQL migration applies cleanly
- [ ] Seed runs, admin + 3 branches + 3 employees exist
- [ ] `RateChange` rows exist for each non-admin user
- [ ] Login works, JWT cookies issued
- [ ] Logout clears cookies
- [ ] Login rate limit triggers at 6th attempt
- [ ] Audit log REVOKE works (app user can't UPDATE)

---

## Phase 2 — Punch + Geofence + Employee PWA

**Goal:** Employee can log in, see their check-in/out button, punch in and out from inside the branch geofence. Day-off and open-trip guards work. Live "minutes since IN" counter.

**Spec sections to read first:** `spec.md` §3.5 (Geofence), §3.6 (Real-time — DROPPED), §3.9 (Cron), §4.7 (Authorization), §5 (Timezone), §8.2 (Geofence), §8.4 (Punch handler), §8.5 (WATCHED resolution), §12 (Quickstart).

### Scope

1. **`apps/web/lib/geofence.ts`** — pure function per `spec.md` §3.5. Pure function, no DB.
2. **`apps/web/lib/services/punch.ts`** — implements the guard order per `spec.md` §8.4.
3. **`apps/web/lib/services/idempotency.ts`** — Postgres-backed idempotency middleware per `spec.md` §4.2.
4. **`apps/web/lib/services/rateLimit.ts`** — Postgres token bucket per `spec.md` §9.
5. **`apps/web/app/api/me/punch/route.ts`** — POST endpoint, Zod-validated, idempotency + rate limit middleware.
6. **`apps/web/app/api/me/today/route.ts`** — GET. Returns `{ in_at, minutes_since_in, earned_today_cent, earned_month_cent, approved_advance_balance_cent, net_cent }` (last 3 fields return 0 for now, computed in Phase 3).
7. **`apps/web/app/api/admin/now/route.ts`** — GET. Single Prisma query per `spec.md` §3.1 (presence only — flags come Phase 4).
8. **`apps/web/app/(app)/employee/page.tsx`** — client component. Calls `navigator.geolocation.getCurrentPosition`, then POSTs to `/api/me/punch`. Shows day-off banner if applicable. Shows "minutes since IN" computed client-side from `in_at` for now.
9. **`apps/web/components/PunchButton.tsx`** — 56×56 px button, green when OUT allowed, red when IN allowed, disabled if day-off or geofence fails.
10. **`apps/web/lib/time/todayInBeirut.ts`** — wraps `packages/time/src/index.ts`.
11. **`apps/web/lib/services/dayOff.ts`** — checks for `ScheduleOverride` with kind=DAY_OFF for today in Beirut.

### Tests to write

- `lib/geofence.test.ts` — haversine accuracy, accuracy rejection, edge cases (exactly at boundary, just outside).
- `lib/services/punch.test.ts` — order of guards (day-off before geofence, etc.), punch insertion writes full 5-field log.
- `lib/services/idempotency.test.ts` — same key returns same response, expired keys ignored.
- `lib/services/rateLimit.test.ts` — token bucket refill, 6th punch attempt rejected.
- `lib/time/todayInBeirut.test.ts` — UTC vs Beirut day boundary (e.g., 23:30 UTC Sunday = Sunday Beirut).

### Build prompt template

```
You are building Phase 2 of the Supermarket EMS. Read these files in order:
1. /spec.md
2. /build.md (Phase 2 section)
3. /AGENTS.md

Your task: implement geofencing, the punch endpoint, employee PWA, and /api/admin/now stub.

CRITICAL CONSTRAINTS:
- lib/geofence.ts is a PURE FUNCTION. No DB calls. No side effects. Returns
  { ok, nearest?, distance?, reason? } per spec.md §3.5.
- Punch handler guard order is FIXED (spec.md §8.4): day-off → open trip → geofence → state
  machine → insert → WATCHED resolution → audit log → return.
- Punch writes 5 evidence fields to DB: lat, lng, accuracy_m, device_fp, ip. ALL FIVE.
- Idempotency middleware reads Postgres IdempotencyKey table (spec.md §4.2). Login is excluded.
- Rate limit: 5 punch attempts per minute per user (spec.md §4.2). 6th = RATE_LIMITED.
- Punch endpoint does NOT trigger WATCHED resolution logic in this phase — that's Phase 4. The
  hook is there but inactive (commented or feature-flagged).
- Employee PWA calls navigator.geolocation with high accuracy. If accuracy > branch.gps_accuracy_max_m,
  show "GPS weak — step outside and retry" and don't POST. **The server still enforces the
  accuracy rule independently** (spec.md §3.5, §9 — "Geofence: reject before DB write if
  accuracy exceeds threshold"). Client-side check is UX; server-side check is the gate.
- /api/admin/now in this phase returns ONLY presence (which users are IN, per branch). Open trips
  and flags come Phase 4.
- Day-off guard reads ScheduleOverride for today's Beirut-local date.
- Live "minutes since IN" is computed client-side as Math.floor((Date.now() - in_at_ms) / 60000).
  Re-fetched every 30s via GET /api/me/today.

DO NOT build: advance requests (Phase 3), trip start/end (Phase 4), admin dashboard UI (Phase 5a).

Commit with message "phase-2: punch + geofence + employee pwa".
```

### Verify prompt template

```
You are verifying Phase 2. Read /spec.md and /build.md (Phase 2).

1. `pnpm test` and confirm all Phase 2 tests pass (geofence, punch, idempotency, rateLimit, time).
2. Start web + worker. Open localhost:3000/login. Log in as the seeded employee (username from seed).
3. With browser dev tools, set geolocation to a fake lat/lng INSIDE the employee's branch radius.
   Click CHECK-IN. Confirm 200 + UI updates.
4. Set geolocation to OUTSIDE radius. Click CHECK-IN. Confirm "GPS weak" or "OUT_OF_GEOFENCE" error.
5. Set geolocation accuracy to >100m. Confirm reject message. **Server-side bypass test:**
   temporarily disable the client-side accuracy check (or use curl directly to /api/me/punch
   with `accuracy: 99999`). Confirm the server still returns LOW_GPS_ACCURACY. The server is
   the gate (spec.md §3.5, §9).
6. Click CHECK-IN 6 times rapidly. Confirm 6th attempt returns 429.
7. Click CHECK-IN, then CHECK-IN again. Confirm "ALREADY_PUNCHED_IN" error.
8. Click CHECK-OUT. Confirm UI updates, "minutes since IN" counter appears.
9. Set geolocation to outside branch. Reload page. Confirm CHECK-IN button disabled with
   "GPS required" message.
10. As admin in another browser session, GET /api/admin/now. Confirm the employee appears as IN
    on their branch.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 2 tests pass
- [ ] Employee can punch in/out from inside geofence
- [ ] Geofence rejection works (outside radius)
- [ ] Low-accuracy rejection works (>100m)
- [ ] Idempotency: same key returns same response
- [ ] Rate limit: 6th punch attempt returns 429
- [ ] Day-off blocks punch
- [ ] /api/admin/now shows the punched-in employee
- [ ] Audit log entry written for each punch

---

## Phase 2.5 — Staging deploy + money functions (tests-first)

**Goal:** Get the code onto a real HTTPS staging URL **and** lock down the three pure-function money/time modules with TDD before anything else touches them.

This phase has two halves that run in parallel:

**Half A (deploy):** wire Coolify to the GitHub repo, set up a `staging` branch → `staging.example.com` subdomain. From Phase 3 onward, every verify prompt repeats the punch flow on the staging URL from a real phone (Safari geolocation demands real HTTPS — devtools-mocked GPS works for unit tests but not for the commute test).

**Half B (pure functions, TDD):** write the Vitest suites FIRST, watch them fail red, then implement to make them green. This is the structural advantage of the build plan — pure functions with full coverage before any web plumbing wires to them.

**Spec sections to read first:** `spec.md` §3.5 (Geofence), §5 (Timezone), §8.3 (Payout).

### Scope

**Deploy half:**
1. **`docker-compose.staging.yml`** — extends docker-compose.yml with staging-specific env names and a `staging.example.com` hostname.
2. **`Dockerfile.web`** and **`Dockerfile.worker`** — multi-stage builds, non-root user.
3. **Coolify configuration** (documented in RUNBOOK): source = GitHub repo, branch = `staging`, build pack = Docker compose, env vars from Coolify secrets. **Coolify is mandatory, not optional** — it gives us an HTTP API and webhook events for the post-launch AI monitoring agent (logs, restart, rollback, metrics). Plain `docker compose` over SSH would force the agent to parse stdout and run shell commands.
4. **Cloudflare DNS**: `staging.example.com` CNAME → Coolify origin. Full strict SSL.
5. **`.github/workflows/ci.yml`** — lint + typecheck + vitest on every PR (gate before merge to staging).
6. **GitHub branch protection**: `main` requires PR + CI green; `staging` auto-deploys.

**Pure-functions half (TDD — tests first):**

1. **`packages/time/src/index.ts`** — see `spec.md` §5. Functions: `todayInBeirut`, `inBeirut`, `scheduledToUtc`, `findScheduleInPast24h`. Pin `date-fns-tz@^2.0.0`.
2. **`apps/web/lib/geofence.ts`** — see `spec.md` §3.5. Pure function `verifyWithinGeofence`. No DB calls.
3. **`apps/web/lib/services/payout.ts`** — see `spec.md` §8.3. Pure function `payoutForUser(userId, month, db)` — reads ONLY from `RateChange`.

### Tests to write FIRST (red, then implement)

- `packages/time/src/index.test.ts` — UTC → Beirut day boundary cases (23:30 UTC Sunday = Sunday Beirut winter/summer), DST transitions if testable (use fixed `Asia/Beirut` dates around known DST windows), `findScheduleInPast24h` for cross-midnight shifts (decision #36).
- `apps/web/lib/geofence.test.ts` — haversine accuracy (1km, 100m, 10m, exactly-at-boundary), accuracy rejection (50m GPS at 60m radius is fine, 150m at 100m max is rejected), `LOW_GPS_ACCURACY` reason returned, `TOO_FAR` reason returned.
- `apps/web/lib/services/payout.test.ts` — single-punch-pair simple case, multi-punch-pair day, multi-rate user (RateChange inserted mid-month → old punches use old rate, new punches use new rate), adjustments add (BONUS positive, DEDUCTION negative), advances subtract, accrued-earnings cap (decision #21).

### Build prompt template

```
You are building Phase 2.5 of the Supermarket EMS. Read /spec.md and /build.md (Phase 2.5).

Your task: deploy to a staging URL on Coolify, AND implement three pure functions in TDD style:
packages/time/src/index.ts, apps/web/lib/geofence.ts, apps/web/lib/services/payout.ts.

CRITICAL CONSTRAINTS:
- TDD: write the .test.ts files FIRST, run vitest, watch them fail red. THEN implement the
  functions to make them green. Commit the test files separately from the implementation.
- date-fns-tz MUST be pinned to ^2.0.0 (spec.md §5). v3 renamed exports — do not "upgrade".
- lib/geofence.ts is a PURE FUNCTION. No DB calls, no side effects. Returns
  { ok, nearest?, distance?, reason? }.
- payout reads ONLY from RateChange. User.hourly_rate_cent is display-only (spec.md §8.3).
- Staging deploy uses a separate branch (staging), separate env vars (DATABASE_URL points to a
  staging DB, not prod). Document the Coolify setup in RUNBOOK.md so it can be reproduced.
- Cloudflare SSL mode: Full (strict). The staging origin cert is from Coolify (Let's Encrypt).
- The Dockerfile runs as non-root user (UID 1001).
- CI on GitHub Actions: pnpm install → typecheck → vitest. Must pass before any merge to staging.

DO NOT build: endpoints, UI, cron jobs. Those come in later phases. This phase is pure functions
+ deploy plumbing only.

Commit sequence (3 commits):
- "phase-2.5-staging: deploy plumbing"
- "phase-2.5-time: tests + impl"
- "phase-2.5-geofence: tests + impl"
- "phase-2.5-payout: tests + impl"
```

### Verify prompt template

```
You are verifying Phase 2.5. Read /spec.md and /build.md (Phase 2.5).

Deploy half:
1. CI green on GitHub Actions for the staging branch.
2. Visit https://staging.example.com in browser. Confirm "Hello EMS" placeholder loads with
   valid HTTPS (padlock icon).
3. Curl the staging URL from a phone (Safari or Chrome on iOS/Android). Confirm it loads.
4. Check Coolify logs — confirm web and worker containers are healthy.

Pure-functions half:
5. `pnpm --filter time test` — all tests green.
6. `pnpm --filter web test geofence` — all tests green. Specifically verify:
   - Boundary case: distance == radius passes; distance == radius + 1m fails.
   - Accuracy 50m at radius 100m: distance 80m passes (80 < 100 + 50); distance 200m fails.
   - LOW_GPS_ACCURACY returned when accuracy > branch.gps_accuracy_max_m.
7. `pnpm --filter web test payout` — all tests green. Specifically verify:
   - Multi-rate user: insert punches at month boundary, insert RateChange mid-month, confirm
     payout splits correctly.
   - Accrued-earnings cap: function returns remaining headroom correctly.
8. Diff all three implementation files against spec.md sections. Report any deviation.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] Staging URL live on HTTPS
- [ ] CI green
- [ ] `lib/time.ts` fully tested (DST edge cases covered)
- [ ] `lib/geofence.ts` fully tested (boundary + accuracy cases)
- [ ] `lib/services/payout.ts` fully tested (multi-rate, accrued-earnings cap)
- [ ] RUNBOOK.md documents the staging deploy

---

## Phase 3 — Advances + Adjustments + Audit endpoints & UI

**Goal:** Payout (built Phase 2.5) is wired to endpoints. Employee can request advance (capped at accrued earnings). Admin can approve/reject. Admin can add bonus/deduction adjustments. Every mutation writes to audit log.

**Spec sections to read first:** `spec.md` §3.3 (Postgres + Prisma), §4.5 (Rate history), §8.3 (Payout), decision #19, #20, #21.

### Scope

1. **`apps/web/app/api/me/advances/route.ts`** — GET (current pending + approved balance) and POST (request, with accrued-earnings cap per decision #21).
2. **`apps/web/app/api/me/payroll/route.ts`** — GET (own numbers; calls payout from Phase 2.5).
3. **`apps/web/app/api/admin/advances/[id]/decision/route.ts`** — POST. Approve/reject + audit log.
4. **`apps/web/app/api/admin/advances/route.ts`** — GET (list pending for admin).
5. **`apps/web/app/api/admin/adjustments/route.ts`** — POST. Add bonus/deduction + audit log.
6. **`apps/web/app/api/admin/payroll/route.ts`** — GET. Full table (month-picker only).
7. **`apps/web/app/api/admin/punches/correct/route.ts`** — POST. Manual correction, audit-logged, NEVER UPDATEs the punch row.
8. **`apps/web/app/(app)/employee/advances/page.tsx`** — request form, shows current pending count + approved balance.
9. **`apps/web/app/(app)/employee/payroll/page.tsx`** — own numbers per month.
10. **`apps/web/app/(app)/admin/pending/page.tsx`** — list of pending advances with approve/reject buttons (deep linkable from Telegram, anchor on `?focus={advanceId}`).
11. **`apps/web/app/(app)/admin/payroll/page.tsx`** — placeholder for now, full impl in Phase 5a. Shows month picker + table.
12. **`apps/web/lib/services/audit.ts`** — `writeAuditLog(actor, action, entity, entityId, before, after)`. Used by every mutation endpoint.

### Tests to write

- `audit.test.ts` — every mutation writes a row.
- `punches/correct.test.ts` — correction writes audit row, doesn't UPDATE punch.
- `advances.test.ts` — accrued-earnings cap server-side, advance approval writes audit.

### Build prompt template

```
You are building Phase 3 of the Supermarket EMS. Read /spec.md and /build.md (Phase 3).

NOTE: payout.ts is already implemented and tested from Phase 2.5. Do NOT re-implement it. Just
import and call it.

Your task: wire the Phase 2.5 payout function into endpoints, implement advance requests,
admin decision endpoint, adjustments, manual punch correction, and the audit log helper.

CRITICAL CONSTRAINTS:
- payout is imported from apps/web/lib/services/payout.ts. It reads ONLY from RateChange
  (spec.md §8.3).
- Advance cap: approved_balance + new_amount <= accrued_earnings_this_month (decision #21).
  If exceeded, return EXCEEDS_ACCRUED_EARNINGS. Server-side check, no client-side bypass.
- Advance statuses: PENDING | APPROVED | REJECTED. NO "PAID" state (decision #20).
- Manual punch correction NEVER UPDATEs the punch row. Writes an AuditLog entry with
  before_json + after_json. The original punch row stays immutable (spec.md §4.3).
- Every mutation in this phase calls writeAuditLog().
- Adjustments: amount_cent is non-negative; sign comes from kind (BONUS=+, DEDUCTION=-).
  spec.md §6 Adjustment has CHECK constraint — verify it.
- All amounts are USD cents (decision #35). No floats.
- Idempotency: every POST in this phase requires Idempotency-Key header.
- Rate limit: admin decision endpoint NOT rate-limited (admin is trusted). Employee advance POST
  IS rate-limited (5/min).
- Month-picker: payroll endpoint accepts ?month=YYYY-MM. Reject any other format.

DO NOT build: Telegram notifications (Phase 5b), PDF (Phase 5b).

Commit with message "phase-3: advances + adjustments + audit".
```

### Verify prompt template

```
You are verifying Phase 3. Read /spec.md and /build.md (Phase 3).

Local:
1. `pnpm test` and confirm all Phase 3 tests pass.

Staging (per Phase 2.5 deploy):
2. Repeat the advance flow on staging URL from a real phone (HTTPS Safari geolocation).
3. Repeat the admin advance approval flow on staging.

Functional:
4. As employee: request advance $50. Confirm pending count goes to 1.
5. As employee: request advance $999999. Confirm EXCEEDS_ACCRUED_EARNINGS error.
6. As admin: GET /api/admin/pending. Approve the $50 advance. Confirm audit log entry written.
7. As employee: GET /api/me/today. Confirm approved_advance_balance_cent = 5000.
8. As admin: POST /api/admin/adjustments with { kind: BONUS, amountCent: 1000, reason: "..." }.
   Confirm audit log entry.
9. As admin: POST /api/admin/punches/correct for any punch with { newAt: <sometime> }.
   Confirm audit log entry written. Confirm the punch row's `at` field did NOT change.
10. As admin: GET /api/admin/payroll?month=2026-07. Confirm table shows user with hours/gross/
    adjustments/advances/net. Confirm numbers are in cents.
11. Manually: change a user's RateChange effective_from to a date in the past. Recompute payout.
    Confirm old rate used for punches before that date, new rate for after.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 3 tests pass
- [ ] Payout computed correctly with rate history (regression check from Phase 2.5)
- [ ] Advance request flow works end-to-end (local + staging)
- [ ] Accrued-earnings cap enforced server-side
- [ ] Adjustments add to payout
- [ ] Manual punch correction writes audit, doesn't mutate punch
- [ ] Audit log has entries for every mutation
- [ ] Admin payroll table loads in <500ms
- [ ] Flow tested on staging URL from a real phone

---

## Phase 4 — Driver trips + Schedule + Leave + Flags

**Goal:** Drivers can start/end trips with geofence. Cron jobs detect watched users and missed checkouts. WATCHED resolution fires inline on punch. Leave requests + admin schedule editor with inline pending requests. Approved leave suppresses flags.

**Spec sections to read first:** `spec.md` §3.9 (Cron), §4 (Driver Features), §5 (Schedules), §6 (Schema: Trip, ScheduleOverride, LeaveRequest, Flag), §8.5 (WATCHED), §8.6 (Missed-checkout).

### Scope

1. **`apps/web/app/api/me/trip/start/route.ts`** — POST. Geofence gate. Idempotency + rate limit.
2. **`apps/web/app/api/me/trip/end/route.ts`** — POST. Geofence gate. Idempotency.
3. **`apps/web/app/api/me/trip/current/route.ts`** — GET. `{ open, since_min, threshold_min }`.
4. **`apps/web/app/api/me/leave/route.ts`** — GET + POST.
5. **`apps/web/app/api/admin/leave/route.ts`** — GET (all).
6. **`apps/web/app/api/admin/leave/[id]/decision/route.ts`** — POST. Approve writes `ScheduleOverride`.
7. **`apps/web/app/api/admin/schedules/[userId]/route.ts`** — GET + PUT.
8. **`apps/web/app/(app)/driver/page.tsx`** — driver PWA with trip banner + OUT/BACK buttons.
9. **`apps/web/app/(app)/employee/leave/page.tsx`** — request form.
10. **`apps/web/app/(app)/admin/schedule/page.tsx`** — weekly grid editor with inline pending requests. Approve from grid → writes `ScheduleOverride`.
11. **`apps/web/lib/services/punch.ts`** — add inline WATCHED resolution (was stubbed in Phase 2, per spec.md §8.5).
12. **`apps/worker/src/jobs/watchedDetector.ts`** — cron `*/1 * * * *` per spec.md §3.9.
13. **`apps/worker/src/jobs/missedCheckout.ts`** — cron `*/1 * * * *` per spec.md §8.6.
14. **`apps/worker/src/jobs/tripThreshold.ts`** — cron `*/1 * * * *`.
15. **`apps/worker/src/jobs/driverStale.ts`** — cron `*/30 * * * *`.
16. **`apps/worker/src/jobs/endOfDayWatcher.ts`** — cron `30 23 * * *`.
17. **`apps/worker/src/index.ts`** — wire all crons.

### Tests to write

- `watchedDetector.test.ts` — creates Flag row, no notification.
- `punch.test.ts` (extension) — inline WATCHED resolution claims flag atomically (race-safety).
- `trip.test.ts` — start/end geofence enforcement, partial unique prevents 2 open trips.
- `leave.test.ts` — approval writes ScheduleOverride, suppresses flag.

### Build prompt template

```
You are building Phase 4 of the Supermarket EMS. Read /spec.md and /build.md (Phase 4).

Your task: implement driver trips, schedule/leave flows, all time-based cron jobs, and
inline WATCHED resolution.

CRITICAL CONSTRAINTS:
- Trip start AND end require geofence at the branch (spec.md §4 #1, #3).
- A driver can have at most ONE open trip at a time. The partial unique index on Trip
  (driver_id) WHERE back_at IS NULL enforces this at DB level.
- Trip threshold cron: one Telegram per trip via threshold_alerted_at dedup (spec.md §3.9).
- Missed-checkout cron fires at schedule_end + 35 min (decision #32, spec.md §3.9, §8.6).
  Use "30 min past shift end" in the Telegram copy; 35 min is implementation only.
- WATCHED resolution: select-then-claim pattern from spec.md §8.5. Race-safe with updateMany.
- End-of-day watcher (30 23 * * *) sends one Telegram per unresolved WATCHED flag.
- Schedule editor admin page: when an employee has a PENDING LeaveRequest, the day-off cell
  in the grid shows "Pending: [Approve] [Reject]" inline. Approve writes
  ScheduleOverride{source: EMPLOYEE_REQUEST}.
- Approved leave suppresses WATCHED detection for that date.
- Idempotency + rate limit on all POST endpoints.

DO NOT build: Telegram bot binding (Phase 5b), PDF (Phase 5b), PWA install prompt (Phase 6).

Commit with message "phase-4: trips + schedule + leave + flags".
```

### Verify prompt template

```
You are verifying Phase 4. Read /spec.md and /build.md (Phase 4).

1. `pnpm test` and confirm all Phase 4 tests pass.
2. As driver: start trip (inside geofence). Confirm UI shows "OUT since X min" banner.
3. Try to start a second trip. Confirm OPEN_TRIP_EXISTS error.
4. As driver: end trip (must be inside geofence). Confirm banner clears.
5. Try to end trip from outside geofence. Confirm OUT_OF_GEOFENCE error.
6. Set the seed employee's schedule to start 30 min ago. Don't punch in. Wait for the watched
   cron to run (max 1 min). Confirm Flag row created.
7. Punch in. Confirm Telegram-equivalent notification fires (in dev, ConsoleNotifier logs it).
   Confirm Flag.notified_at is set.
8. Set the seed employee's schedule to end 35 min ago. Don't punch out. Wait 1 min. Confirm
   MISSED_CHECKOUT Flag row created and console log shows the neutral message.
9. As employee: POST /api/me/leave for tomorrow (DAY_OFF). As admin: approve via
   /api/admin/leave/{id}/decision. Confirm ScheduleOverride row written with
   source=EMPLOYEE_REQUEST.
10. Tomorrow: try to punch in. Confirm DAY_OFF_PUNCH_BLOCKED error.
11. As admin: open /admin/schedule for the employee with the approved leave. Confirm day-off
    cell shows the approved marker.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 4 tests pass
- [ ] Driver trip start/end with geofence
- [ ] One open trip enforced at DB level
- [ ] WATCHED cron + inline resolution (race-safe)
- [ ] Missed-checkout cron with 35-min buffer
- [ ] Trip threshold cron with dedup
- [ ] Driver-stale cron
- [ ] End-of-day watcher
- [ ] Leave request flow works
- [ ] Approved leave suppresses flags and blocks punch

---

## Phase 5a — Admin Dashboard UI

**Goal:** Owner can navigate every admin screen and perform every CRUD operation from a phone.

Phase 5 is split to avoid mixing integration work (Telegram API, real tokens, PDF rendering) with UI work — agents get sloppy when a single prompt has both. This half is UI only. Phase 5b handles Telegram + PDF + templates.

**Spec sections to read first:** `spec.md` §3.7 (Notifications — UI surface only), §6 (Admin endpoints), §7.4, §8.8 (Notification prefs UI).

### Scope

1. **`apps/web/app/(app)/admin/page.tsx`** — full dashboard. Polls `/api/admin/now` every 10s. Shows presence per branch, drivers out, today's flags.
2. **`apps/web/app/(app)/admin/now.tsx`** — client island (10s polling).
3. **`apps/web/app/(app)/admin/users/page.tsx`** — CRUD. Modal for create user with role selector + initial rate. Reset password button returns `{ temp_password }`.
4. **`apps/web/app/(app)/admin/branches/page.tsx`** — form with lat/lng/radius/accuracy-max/trip-threshold/absent-grace.
5. **`apps/web/app/(app)/admin/adjustments/page.tsx`** — list + add form.
6. **`apps/web/app/(app)/admin/punches/page.tsx`** — list with "correct" modal.
7. **`apps/web/app/(app)/admin/flags/page.tsx`** — flags feed, newest first.
8. **`apps/web/app/(app)/admin/payroll/page.tsx`** — month picker + table + "Download PDF" button (PDF endpoint wired in Phase 5b, button shows "coming soon" until then).
9. **`apps/web/app/api/admin/users/[id]/notification-prefs/route.ts`** — PATCH with 2 booleans.

### Tests to write

- Admin UI tests are minimal in v1 (manual verification). Add one Playwright test for the
  "create user" flow.

### Build prompt template

```
You are building Phase 5a of the Supermarket EMS. Read /spec.md and /build.md (Phase 5a).

Your task: build the admin dashboard UI screens — users, branches, adjustments, punches, flags,
payroll placeholder. NO Telegram integration, NO PDF rendering (those are Phase 5b).

CRITICAL CONSTRAINTS:
- /api/admin/now polls every 10s. Single endpoint, single query (spec.md §3.1).
- Admin user list page: "Create user" modal requires username, role, branch, initial rate.
  Initial rate MUST write a RateChange row in the same transaction (spec.md §8.3).
- Reset password: returns { temp_password } in response. Server generates 12-char random password,
  bcrypts, updates User, returns plaintext once.
- Notification prefs UI: exactly 2 toggles (daily summary, routine pings) — see spec.md §8.8.
- Branch form: lat/lng validated as numeric, radius default 50, accuracy max default 100.
- Every button ≥56×56 px (spec.md §3.2). Mobile-first.
- Staging test required (per Phase 2.5 deploy): every screen must render on a real phone at
  https://staging.example.com before "done."

DO NOT build: Telegram integration, PDF rendering, notification templates. All Phase 5b.

Commit with message "phase-5a: admin dashboard ui".
```

### Verify prompt template

```
You are verifying Phase 5a. Read /spec.md and /build.md (Phase 5a).

1. `pnpm test` passes.
2. Visit staging URL on a real phone. Navigate every admin screen. Confirm:
   - Dashboard polls every 10s (devtools network tab).
   - Users page: create/edit/deactivate/reset-password work.
   - Branches page: form loads, edits save, lat/lng accepted.
   - Adjustments, Punches, Flags pages render with real data.
   - Notification prefs: 2 toggles visible, PATCH works.
3. Create a new user via the UI. Confirm RateChange row exists in DB.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 5a tests pass
- [ ] Every admin screen renders on a real phone at staging URL
- [ ] User CRUD writes RateChange in same tx
- [ ] Reset password returns temp_password
- [ ] Notification prefs toggles work

---

## Phase 5b — Telegram + PDF + notification templates

**Goal:** Wire the Telegram bot, render the payroll PDF, define every notification template. Integration-heavy work isolated from UI work.

**Spec sections to read first:** `spec.md` §3.7 (Notifications), §3.8 (PDFs), §7.4 (Admin endpoints), §8.7 (Notifier), §8.8 (Notification prefs).

### Scope

1. **`packages/notify/src/telegram.ts`** — `TelegramNotifier` impl. `sendMessage(chatId, text, deepLink?)`.
2. **`apps/web/app/api/telegram/webhook/route.ts`** — receives `/start` from bot. Validates `X-Telegram-Bot-Api-Secret-Token`. Writes `chat_id` to `User.telegram_chat_id` for admin.
3. **`apps/worker/src/notifier/send.ts`** — implements the 2-toggle prefs logic per spec.md §8.8.
4. **`apps/worker/src/jobs/dailySummary.ts`** — cron `0 23 * * *`.
5. **`packages/pdf/src/payroll.tsx`** — React-PDF doc. Per-employee hours/gross/adjustments/advances/net. Per-branch totals.
6. **`apps/web/app/api/admin/reports/payroll/route.ts`** — GET. Streams PDF.
7. **Wire the "Download PDF" button** in `apps/web/app/(app)/admin/payroll/page.tsx` (was placeholder in Phase 5a).
8. **`apps/worker/src/notifier/templates/`** — pure template functions for each message type: `watched.resolved`, `trip.over_threshold`, `missed.checkout`, `advance.requested`, `daily.summary`.

### Tests to write

- `telegram.test.ts` — `TelegramNotifier.send()` calls correct API URL, handles errors.
- `payrollPdf.test.ts` — renders, includes all required fields.
- `notifier/templates.test.ts` — each template renders with full context.
- `webhook.test.ts` — `/start` writes chat_id, secret token rejected.

### Build prompt template

```
You are building Phase 5b of the Supermarket EMS. Read /spec.md and /build.md (Phase 5b).

Your task: TelegramNotifier, webhook, notification templates, daily summary cron, payroll PDF.
NO admin UI changes (Phase 5a already shipped those).

CRITICAL CONSTRAINTS:
- Telegram is READ-ONLY (decision #11). No inline buttons, no callback queries. Deep links only.
- TelegramNotifier writes are fire-and-forget with retry-once; never block the request.
- /api/telegram/webhook validates X-Telegram-Bot-Api-Secret-Token (spec.md §9).
- Notification prefs: 2 booleans on User (spec.md §8.8). Exceptions always fire.
- Payroll PDF: uses @react-pdf/renderer, NOT Puppeteer (spec.md §3.8). Includes all employee
  payouts + per-branch totals + signature line at bottom.
- Daily summary cron at 0 23 * * * (spec.md §3.9). Skipped if admin's notify_daily_summary=false.
- Each template is a pure function (user, punch?, watched?) → { text, deepLink? }.
- Test templates with snapshot tests so message format changes are caught.

Commit with message "phase-5b: telegram + pdf + templates".
```

### Verify prompt template

```
You are verifying Phase 5b. Read /spec.md and /build.md (Phase 5b).

1. `pnpm test` all Phase 5b tests pass.
2. Configure TELEGRAM_BOT_TOKEN in staging env. Restart worker.
3. As admin in Telegram app, send /start to the bot. Confirm User.telegram_chat_id is populated.
4. Trigger an advance request from staging URL. Confirm deep-link Telegram message arrives.
5. As admin, download payroll PDF for current month. Confirm it includes all employees + branch
   totals + signature line.
6. Toggle notify_daily_summary=false on staging. Confirm daily summary skipped at 23:00.
7. Trigger WATCHED resolution: stop an employee from punching in past their grace, then have them
   punch in. Confirm Telegram message arrives with full context (employee, watched since, resolution).
8. Open /api/admin/reports/payroll?month=invalid. Confirm 400 INVALID_INPUT.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 5b tests pass
- [ ] Telegram bot binds via /start
- [ ] Deep-link messages arrive on all event types
- [ ] Notification prefs toggles work (daily summary skip verified)
- [ ] Payroll PDF downloads with full data
- [ ] Templates covered by snapshot tests

---

## Phase 6 — Polish + PWA + Observability + Backups

**Goal:** Production-ready. PWA installable. Sentry + structured logs. Backup pipeline with restore drill. Health endpoints. UptimeRobot. Final polish pass.

**Spec sections to read first:** `spec.md` §3.10 (Backups), §3.11 (Observability), §3.12 (Testing), §10.5 (Post-launch deferred).

### Scope

1. **`apps/web/public/manifest.json`** — PWA manifest with icons.
2. **`apps/web/public/sw.js`** — minimal service worker (offline shell for login + employee home).
3. **`apps/web/lib/sentry.ts`** — Sentry init (server-side).
4. **`apps/web/app/api/health/route.ts`** — returns `{ ok: true }`.
5. **`apps/web/app/api/health/db/route.ts`** — runs `SELECT 1`, returns 200 if <50ms.
6. **`scripts/backup.sh`** — pg_dump → gpg → local retention → rclone to Google Drive.
7. **`scripts/restore.sh`** — accepts dump path, restores to a target DB.
8. **`RUNBOOK.md`** — restore procedure, common ops, monitoring alerts.
9. **UI polish pass** — loading states, empty states, color semantics, 56×56 button targets.
10. **`apps/web/app/(public)/login/page.tsx`** — add manifest link, install prompt on second visit.
11. **`apps/web/middleware.ts`** — log structured events.
12. **CI pipeline** (`.github/workflows/ci.yml`) — lint + typecheck + vitest on every PR.
13. **`OWNER_CHEATSHEET.md`** — one-page PDF or printable HTML the owner can keep at the branch. Covers: approve advance, correct a punch, add a user, download payroll PDF, change branch radius. Screenshots embedded. Written for someone who has never seen the dashboard. **This is what makes the pilot self-sustaining after Kyvera leaves.**

### Tests to write

- `backup.test.ts` — script handles missing dump file gracefully.
- `health.test.ts` — both endpoints return 200 in happy path.
- `sw.test.ts` — service worker registers without errors.

### Build prompt template

```
You are building Phase 6 of the Supermarket EMS. Read /spec.md and /build.md (Phase 6).

Your task: production hardening. PWA, observability, backups, polish, CI.

CRITICAL CONSTRAINTS:
- Service worker is MINIMAL. Caches only the login page + employee home shell. Do NOT cache
  API responses.
- Sentry: server-side only. No client-side Sentry in v1.
- Backup script: reads /run/secrets/backup.key (mounted by Coolify). NEVER hardcode the key.
- rclone config: assume ~/.config/rclone/rclone.conf is mounted. Config name: gdrive.
- Health endpoint /api/health/db uses SELECT 1, returns 200 only if latency <50ms. Otherwise 503.
- RUNBOOK.md must include: restore from backup (step by step), how to add a new branch, how to
  reset admin password, common alerts and what they mean.
- UI polish: every button ≥56×56 px. Every async action has loading state. Empty states have
  friendly copy ("No punches today yet — check in to get started").
- **OWNER_CHEATSHEET.md** must include screenshots of every flow (approve advance, correct punch,
  add user, download PDF, change radius). Print-friendly. Owner reads it WITHOUT you in the room.
  Tested by handing the PDF to someone unfamiliar with the system — they should be able to do
  every action from the cheat sheet alone.

Commit with message "phase-6: polish + pwa + observability + backups".
```

### Verify prompt template

```
You are verifying Phase 6. Read /spec.md and /build.md (Phase 6).

1. `pnpm test` all tests pass.
2. Open Chrome devtools → Application → Manifest. Confirm PWA manifest loads.
3. Service worker registers without errors in console.
4. Manually trigger backup.sh. Confirm dump file created in /var/backups/ems/ with correct date.
5. Manually decrypt the dump and confirm contents (pg_restore --list).
6. Test restore.sh on a staging DB. Confirm rows match source.
7. curl /api/health. Confirm 200. Kill Postgres. curl again. Confirm 503.
8. Confirm Sentry receives a test error (throw in a route, hit it, check dashboard).
9. Lighthouse mobile audit on /login and /employee. Confirm PWA installable.
10. CI: push a PR. Confirm lint + typecheck + tests run.

Report any deviation as FAIL.
```

### Exit criteria

- [ ] All Phase 6 tests pass
- [ ] PWA installable (Lighthouse pass)
- [ ] Backup script runs, dump + restore work
- [ ] Health endpoints respond correctly
- [ ] Sentry receives errors
- [ ] RUNBOOK.md complete and accurate
- [ ] CI green
- [ ] UI polish pass complete
- [ ] OWNER_CHEATSHEET.md exists, has screenshots, tested with a non-Kyvera person

---

## Phase 7 — Field testing & pilot

**NOT a build phase.** This is the field-test phase described in `spec.md` §10.3.

### Activities (Kyvera + Owner)

- Week 7: Developer on-site at branch 1 (~3 days). Train staff. Watch first punch in real conditions.
- Week 7–8: Quiet field test with 2–3 selected employees.
- Week 8: Live pilot at branch 1 with all staff.
- Week 8 end: Bug-fix window. NO new features.
- Week 9 day 1: Rollout to branches 2 and 3 (1 day).

### Exit criteria

- [ ] No payroll-affecting bugs in pilot (spec.md §10.3)
- [ ] Owner can run payroll end-to-end (download PDF, verify numbers)
- [ ] Telegram alerts arriving as expected
- [ ] No data loss
- [ ] Backups verified

### Build prompt template

(There is no build prompt for Phase 7. Use field-test notes to drive Phase 8 = bug fixes, which is itself a build phase. Insert "Phase 7.5: bug fixes from field test" between pilot and rollout.)

---

## Phase 8 — Bug fixes from field testing (only if needed)

**Goal:** Address issues found during pilot. No new features.

**Build prompt template:**

```
You are addressing field-test bugs from the pilot. Read /spec.md, /build.md, and
/field-test-notes.md (created during pilot).

Your task: fix bugs in priority order. Do NOT add features. Do NOT refactor unrelated code.

CONSTRAINTS:
- Each bug fix gets a commit: "fix(phase-8): <one-line summary>"
- Each fix is verified with a test that reproduces the bug.
- If a fix requires changing spec.md, STOP and ask first. Spec is locked.
```

---

## Cross-cutting concerns

### File naming conventions

- **One concept per file.** `payout.ts` exports `payoutForUser`. Don't dump the entire payroll module in one file.
- **Routes:** `/app/api/{path}/route.ts` with named exports `GET`, `POST`, etc.
- **Components:** PascalCase, one per file: `PunchButton.tsx`, `ScheduleGrid.tsx`.
- **Services:** camelCase, pure functions where possible: `payout.ts`, `geofence.ts`.
- **Tests:** co-located, `*.test.ts` suffix.

### What NEVER to do (from spec.md and decisions)

- **No floats for money.** All money is `Int` cents.
- **No `UPDATE` on append-only tables.** Corrections go to `AuditLog`.
- **No new device fingerprinting.** Cut in decision #22.
- **No real-time infra.** Polling only (decision #17).
- **No event bus.** Cron + inline (decision #10).
- **No CSV export.** PDFs only (decision #23).
- **No `PAID` state on advances.** Manual payment (decision #20).
- **No opening/closing times.** Stores 24/7 (decision #18).
- **No inline Telegram buttons.** Deep links only (decision #11).
- **No arbitrary date-range filter.** Month-picker only (decision #24).

### How to write a good build prompt for a phase

1. **Always start with:** "Read /spec.md, /build.md (this phase), /AGENTS.md."
2. **Be explicit about the CRITICAL CONSTRAINTS** — paste the relevant decisions verbatim from spec.md.
3. **Reference sections by anchor** (`spec.md §8.5`), never by line numbers. Line numbers rot the first time `spec.md` is edited; section anchors are stable.
4. **End with what NOT to build** — prevents scope creep into later phases.
5. **Specify the commit message format** so commits are searchable.

### How to write a good verify prompt

1. **Start with "Read /spec.md and /build.md (this phase)."**
2. **List concrete actions** ("curl /api/admin/now and confirm X").
3. **Use real data** from seed.ts (the seeded admin username, the sample employee).
4. **End with "Report any deviation as FAIL."** No soft language.

---

## When to STOP and ask the human

Stop and ask before doing any of these:

- Changing `spec.md` (it's locked).
- Adding a new dependency not in `package.json`.
- Touching multiple phases in one commit.
- "While I'm here" refactors.
- Adding a feature the user didn't request.

When in doubt, **ask**. The point of phase isolation is that any question is small enough to resolve in one round-trip.

---

**End of build plan. Begin with Phase 0.**