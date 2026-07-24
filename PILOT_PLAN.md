# Single-Branch Pilot Plan

**Goal:** Deploy EMS to **one branch only** (Home Office), with **2-3 employees** (admin + emp1 + maybe emp2), for **1-2 weeks** of real-world testing before scaling to all branches.

**Why single-branch first:**
- Lowest risk — if something breaks, you know exactly which branch exposed the bug
- Tarek Jdedi stays on the legacy system until Home Office proves stable
- Owner can demo to a real user without disrupting an in-flight business
- All the same code paths tested — auth, payroll, geofence, etc.

---

## Scope

### In scope (this pilot)
- 1 branch: **Home Office** with real captured GPS coords
- 2 users: `owner` (admin) + `emp1` (employee)
- Full feature set: admin UI, punch flow, payroll, branches, advances
- Local Coolify OR a simple VPS deploy (TBD — owner decides)

### Out of scope (this pilot)
- Tarek Jdedi branch (still on legacy, not yet migrated)
- Telegram bot (Phase 5b — Phase 7-something)
- PDF download (already verified locally)
- PWA install (skipped per original spec)
- Backup automation (stub for now)

---

## Pre-flight checklist

Before the pilot starts, verify:

- [ ] Both branches have **real coordinates** captured via Record Location
- [ ] Tarek Jdedi geofence params need updates (currently 0,0 — would fail every punch)
- [ ] `emp1` and `emp2` have real schedules (replace synthetic "Sat-Thu 09:00-18:00" with actual shifts)
- [ ] Admin tested via Chrome on his phone (real mobile UX)
- [ ] `emp1` tested via Chrome on employee phone (real GPS, real geofence)
- [ ] At least one employee advance request → admin approve → payroll reflects it
- [ ] One missed checkout → admin received notification (or noted in flags)
- [ ] PDF download contains real data (not just "no rows")

---

## Success criteria (after 1 week)

The pilot is **successful** if:

1. ✅ All employees punch in/out from real locations (no errors)
2. ✅ Geofence correctly rejects out-of-store punches
3. ✅ Payroll numbers match what owner calculates manually for 1 week
4. ✅ No data loss (DB still has all punches)
5. ✅ Admin can correct a punch via /admin/punches
6. ✅ Owner can demo to client without crashes

If any of these fail → fix before scaling to Tarek Jdedi.

---

## Risk register

| Risk | Mitigation |
|---|---|
| GPS accuracy too low (employee can't punch from inside the store) | Loosen `gps_accuracy_max_m` to 200m for Home Office specifically |
| Pilot Internet outage | Local mode is only deployable if VPS has backup. Otherwise accept downtime. |
| Owner forgets to check flags daily | Set up Telegram bot (Phase 5b) before pilot starts |
| Cookies expire while employee is mid-punch | 8-hour access token TTL — exceeds typical shift. Refresh on next login. |
| Punch data deleted by mistake | All mutations write to audit log. Reconstruct from log if needed. |

---

## Rollback plan

If the pilot fails catastrophically:

1. Stop the Coolify/VPS app
2. Have employees revert to manual time tracking (paper / spreadsheet)
3. Data collected during pilot is preserved in the DB (don't delete the volume)
4. Owner can resume from same state after fixes

---

## After successful pilot (roll-out to Tarek Jdedi)

1. Capture Tarek Jdedi's actual GPS via Record Location
2. Update `emp2` schedule to reflect Tarek's specific working hours
3. Deactivate any remaining legacy time tracking
4. Onboard Tarek's employees with login credentials
5. First full payroll run with both branches

---

## Status

- [x] Phase 7 — Record Location feature shipped
- [x] Phase 5b — PDF + Telegram bot code shipped (Telegram unverified locally, no real bot)
- [x] Phase 6a — Production hardening (health checks, CI, runbook, Dockerfiles) shipped
- [x] Phase 6b — Sentry dep shipped (sync broken, but not blocking)
- [ ] Pre-flight checklist (above)
- [ ] Pilot starts
- [ ] Pilot review at 1 week
- [ ] Roll-out to Tarek Jdedi

**ETA:** Whenever owner confirms branches have real coords + Docker daemon is stable.
