# Hours-based scheduling, shortfall penalties and overtime review

**Date:** 2026-08-15
**Status:** approved, pending implementation plan

## Problem

The schedule pins each weekday to a clock window (`start_time`, `end_time`) and
the penalty engine measures two separate offences against it: arriving after the
start (`LATE`) and leaving before the end (`EARLY_LEAVE`).

That model fights the way the shop actually runs. An overnight shift (21:00 Mon →
07:00 Tue) has to be special-cased everywhere it appears, and an employee who
arrives two hours late but stays two hours later — covering the full shift — is
still penalised for lateness.

What the owner actually cares about is coverage: **did this person work the
number of hours I set for that day?**

## Goal

Replace the clock window with a single number of hours per weekday. Penalise
failure to cover it. Surface overtime for review, because hours worked are paid
automatically today and nobody is told when someone runs long.

## Decisions

Settled with the owner before writing this:

| Question | Decision |
|---|---|
| Shift definition | One number of hours per weekday, 0–24, no negatives |
| Name shown to the owner | "Shift hours" |
| Break punching | Does not exist. One IN on arrival, one OUT on leaving |
| When shortfall is judged | Immediately on punch OUT |
| Shortfall pricing | Unchanged from today |
| Late arrival | No longer an offence — there is no start time to be late against |
| Unscheduled day (0 hours set) | Every hour worked is overtime |
| Overtime grace | Per branch, owner-editable, anti-spam only |
| Overtime rate | Normal hourly rate |
| No-show (no punch at all) | Notice only, no automatic penalty |
| Existing beta data | Disposable — no cutover, everything recomputes |

## Data model

### Schedule

```
weekday    Int   // 0=Sunday .. 6=Saturday, unchanged
shift_min  Int   // NEW: minutes to cover that weekday
```

`start_time` and `end_time` are dropped.

Stored as minutes rather than hours so a 7.5-hour shift stays representable —
the same reason money is stored in cents. The UI presents hours and accepts
halves; the API converts. A raw SQL CHECK mirrors the existing schema
convention:

```sql
ALTER TABLE "Schedule" ADD CONSTRAINT schedule_shift_min_chk
  CHECK (shift_min >= 0 AND shift_min <= 1440);
```

### ScheduleOverride and LeaveRequest

Both carry `start_time`/`end_time` today so a single date can deviate from the
weekly pattern. Both swap to a nullable `shift_min` under the same CHECK.
`OverrideKind.TIME_CHANGE` is renamed `HOURS_CHANGE`.

### Branch

`absent_grace_min` is renamed `overtime_grace_min` (default 15). The field is
currently dead — the branch screen writes it and nothing reads it, with the
no-show job hardcoding 30 minutes instead. It now carries the overtime
notification threshold.

### PenaltyKind

Collapses to a single value:

```
enum PenaltyKind { SHORTFALL }
```

`LATE` and `EARLY_LEAVE` are removed. **This migration deletes every
`PenaltyWaiver` and `PenaltyAck` row referencing them.** Authorised explicitly:
the system is in beta and the owner has confirmed existing punches and penalties
are disposable. It must still be called out in the deploy notes, because it is
irreversible without a restore.

### OvertimeDecision (new)

```
user_id     String
date        Date
decision    OvertimeDecisionKind   // ACCEPTED | REVOKED
reason      String?
decided_by  String
created_at  DateTime
@@unique([user_id, date])
```

Mirrors the existing `PenaltyWaiver` / `PenaltyAck` pattern: the absence of a row
means "pending", and pending overtime is paid. `ACCEPTED` takes it off the queue
and changes no money. `REVOKED` deducts that day's excess from payroll.

## Coverage: one source of truth

A new `apps/web/lib/services/coverage.ts` owns the question both features depend
on. Pure, no DB, unit-testable once:

```ts
interface DayCoverage {
  date: string;      // YYYY-MM-DD, Beirut
  requiredMin: number;
  workedMin: number;
  deltaMin: number;  // worked - required; negative is a shortfall
  closed: boolean;   // false while a check-in has no matching checkout
}
```

Rules:

- A shift belongs to the Beirut day the employee **checked in**. A 21:00 Monday
  start ending 07:00 Tuesday is Monday's shift, entirely. This is what removes
  the overnight special-casing.
- `workedMin` sums all IN→OUT pairs in the day. Policy says there is only one
  pair, but summing is correct if the data ever holds more, and it never
  silently drops time.
- An unmatched IN leaves the day `closed: false`. Unclosed days are not judged
  for shortfall or overtime — hours are unknowable until the punch is corrected.
- `requiredMin` resolves in order: a `HOURS_CHANGE` override for that date, else
  a `DAY_OFF` override meaning 0, else the weekday's `Schedule.shift_min`, else 0.

`penalty.ts` and the new `overtime.ts` both consume `DayCoverage`. Neither
recomputes hours itself.

## Shortfall penalties

Replaces the `LATE` and `EARLY_LEAVE` branches of `computePenalties`.

For each closed day where `deltaMin < 0`, the pricing rule carries over
untouched:

```
penaltyHours = min(4, floor(shortfallMinutes / 15))
amount_cent  = penaltyHours * rateAt(employee, day)
```

The 15-minute step means a shortfall under 15 minutes costs nothing, which
preserves today's implicit grace. `rateAt` already resolves each employee's own
rate history, so no change is needed there.

Penalties remain computed on the fly rather than stored, so a shortfall appears
the moment the employee punches out. No worker job is involved.

Waive (revoke) and acknowledge (approve) keep their existing routes and
semantics, now keyed on `SHORTFALL`.

## Overtime

For each closed day where `deltaMin > branch.overtime_grace_min`:

```
overtimeMin    = deltaMin
amount_cent    = floor(overtimeMin * rate / 60)   // already inside gross pay
```

The grace exists solely to stop the queue filling with one- and four-minute
overruns. It is not forgiveness — a 90-minute overrun reports all 90 minutes,
not 90 minus the grace.

Because `pairHours` already pays every minute worked, an overtime notice is a
report on money **already committed**, not a request to add any. That is why
pending means paid. `REVOKED` makes payroll subtract that day's excess:

```
overtimeDeductionCent = sum over revoked days of floor(deltaMin * rate / 60)
netCent = grossCent + adjustments - advances - penalties - overtimeDeduction
```

A day set to 0 hours — unscheduled, or a `DAY_OFF` override — has
`requiredMin = 0`, so all of it is overtime and none of it is paid without the
owner seeing it. This falls out of the rule rather than needing a special case.

## Absence

`watchedDetector` currently fires 30 minutes after a scheduled start when no
punch exists. With no start time, that trigger is gone.

It becomes a once-daily check shortly after midnight, judging the day that just
closed: `shift_min > 0`, no `DAY_OFF` override, and zero punches that Beirut day
→ one `WATCHED` flag, notice only, no money.

Running it after the day closes is what makes it safe. An employee who starts at
23:00 has already punched by the time it runs, so a late-night start cannot be
misread as an absence. The existing one-flag-per-user-per-day guard is kept —
it was added because dismissing a flag made the guard stop matching and the
notice appeared to resurrect itself.

Absence is deliberately not priced. The owner chose notice-only: an employee
missing from the schedule entirely is more often a roster question than a
discipline one.

## Missed checkout

`missedCheckout` fires 35 minutes past a scheduled end today. It becomes: an
open check-in whose elapsed time exceeds `shift_min + overtime_grace_min`.
Same flag, same notification, same one-per-day guard.

## Driver sessions

`sessionExpiryFor` keeps drivers logged in until 30 minutes after their
scheduled end, via `findScheduleInPast24h`. With no end time it becomes: while a
driver has an open check-in the session stays alive, expiring 30 minutes after
checkout. A driver with no open punch falls back to the standard employee TTL.

`SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN` is renamed
`SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN` — same 30-minute value, but the old name
would describe a schedule end that no longer exists.

`findScheduleInPast24h` and `ResolvedSchedule` are deleted — nothing else uses them.

## UI

**Schedule editor** (`admin/users/page.tsx`) — the two time inputs per weekday
become one number input labelled **"Shift hours"**, accepting 0–24 in steps of
0.5, empty meaning not scheduled. This is the screen the owner touches most, so
the weekly total should be shown alongside; it is the number they are really
setting.

**Needs attention** (`AdminDashboard.tsx`) — three notice types where there were
two:

- Shortfall: "X covered 6h of 8h — short 2h. Penalty of $Y applied." Approve / Revoke.
- Overtime: "X exceeded their 8h shift by 1h 20m. $Y paid." Accept / Revoke.
- Absence: "X was scheduled 8h and did not punch." Dismiss.

Each states what happened and what it cost, matching the wording work already
done across the attention queue.

**Branch editor** — "Absent grace" is relabelled "Overtime grace", with help text
saying it only suppresses small overruns.

**Employee hours-change request** (`employee/leave/page.tsx`) — requests a number
of hours for a date instead of a time window.

## API

- `PUT /api/admin/schedules/[userId]` — takes `shift_hours` per weekday, rejects
  outside 0–24, stores minutes.
- `POST /api/admin/overtime/decision` — new. `{ userId, date, decision, reason? }`,
  admin only, CSRF + Idempotency-Key, writes an `AuditLog` entry like every other
  mutation.
- `GET /api/admin/overview` — gains overtime and absence notices.
- Existing penalty ack/waive routes are unchanged apart from the kind.

## Testing

Unit, no DB, against `coverage.ts`:

- overnight shift attributed wholly to the check-in day
- multiple IN/OUT pairs summed
- unmatched IN leaves the day unclosed and unjudged
- `HOURS_CHANGE` override beats the weekday value; `DAY_OFF` forces 0

Unit against shortfall and overtime:

- 14 minutes short costs nothing; 15 costs one hour; cap holds at 4
- overrun inside the grace is silent; past it, the full overrun is reported
- unscheduled day makes every minute overtime
- revoked overtime deducts exactly that day's excess and nothing else

Integration:

- schedule PUT rejects 25 hours and negatives
- overtime decision is admin-only, idempotent, and writes an audit row

The existing penalty tests that assert lateness are deleted rather than adapted —
lateness is no longer a concept, and rewriting them would invent behaviour
nobody asked for.

## Out of scope

- Premium overtime rates. Overtime pays the normal rate.
- Per-employee grace. The grace is per branch.
- Backfilling or preserving beta penalties.

## Follow-up, not part of this work

`initSentry` covers the web app only; a crashing worker cron is visible solely in
container logs. Wiring the worker into Sentry needs `@sentry/node`, a new
dependency, and is the owner's call.
