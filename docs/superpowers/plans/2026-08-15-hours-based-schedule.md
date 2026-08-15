# Hours-Based Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace each weekday's clock window with a number of hours to cover, penalise failure to cover it, and surface overtime for owner review.

**Architecture:** A new pure module `coverage.ts` answers "how many minutes did this person owe and work on each day", attributing every shift to the Beirut day the employee checked in. Shortfall penalties and overtime notices both derive from it, so hours are computed once. The change is mostly rewiring existing call sites; the legacy columns are dropped only in the final task, so every intermediate commit leaves the tree green.

**Tech Stack:** Next.js 14 App Router, Prisma 5 / PostgreSQL 16, Vitest, TypeScript strict, pnpm workspaces.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-hours-based-schedule-design.md`. Read it before Task 1.
- TypeScript strict everywhere. pnpm only — never npm or yarn.
- No emoji in code. No comments unless they explain a non-obvious decision.
- All money is `Int` cents. All durations in this feature are `Int` minutes.
- No new dependencies. Adding one requires justification in the commit message.
- Conventional Commits: `feat(scope):`, `fix(scope):`, `chore:`, `docs:`, `test:`.
- Every API response is `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- Every mutation re-checks role, requires CSRF, and writes an `AuditLog` entry.
- Shift hours are 0–24 inclusive, stored as 0–1440 minutes, enforced by a raw SQL CHECK.
- A shift belongs to the Beirut day the employee **checked in**.
- Run `pnpm -r typecheck` before every commit. It must pass.
- Unit tests: `pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts"`.
- Integration tests need the web app running at `TEST_BASE_URL` plus Postgres.

---

### Task 1: Rename `Branch.absent_grace_min` to `overtime_grace_min`

The field is currently dead — the branch screen writes it and no logic reads it. Renaming first, on its own, keeps it out of the larger change.

**Files:**
- Modify: `packages/db/prisma/schema.prisma:94`
- Create: `packages/db/prisma/migrations/20260815120000_rename_overtime_grace/migration.sql`
- Modify: `apps/web/app/api/admin/branches/route.ts:50`
- Modify: `apps/web/app/api/admin/branches/[id]/route.ts:58,69,70`
- Modify: `apps/web/app/(app)/admin/branches/page.tsx:14,119,186`
- Modify: `apps/web/lib/test-helpers/db.ts:76,90`
- Modify: `apps/web/lib/services/punch.test.ts:17,35,110`
- Modify: `apps/web/lib/services/trip.test.ts:86`
- Test: `apps/web/lib/services/admin-branches.integration.test.ts:40,43`

**Interfaces:**
- Consumes: nothing.
- Produces: `Branch.overtime_grace_min: number` (default 15), and the request field `overtimeGraceMin` on both branch routes.

- [ ] **Step 1: Update the schema field**

In `packages/db/prisma/schema.prisma`, replace line 94:

```prisma
  overtime_grace_min Int     @default(15)
```

- [ ] **Step 2: Write the migration**

Create `packages/db/prisma/migrations/20260815120000_rename_overtime_grace/migration.sql`:

```sql
ALTER TABLE "Branch" RENAME COLUMN "absent_grace_min" TO "overtime_grace_min";
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run:

```bash
pnpm --filter db exec prisma migrate deploy && pnpm --filter db db:generate
```

Expected: migration applies, client regenerates.

- [ ] **Step 4: Rewire every reference**

In `apps/web/app/api/admin/branches/route.ts:50` and `apps/web/app/api/admin/branches/[id]/route.ts:58`, replace `body.absentGraceMin` with `body.overtimeGraceMin` and the column `absent_grace_min:` with `overtime_grace_min:`. Update the Zod body schema in each file the same way.

In `apps/web/app/api/admin/branches/[id]/route.ts:69-70`, the audit `before`/`after` objects each name the column — change both to `overtime_grace_min`.

In `apps/web/app/(app)/admin/branches/page.tsx`, change the interface field at line 14, and the display at line 119 to:

```tsx
<Row k="Overtime grace" v={`${b.overtime_grace_min} min`} />
```

At line 186 change `absentGraceMin: String(branch.absent_grace_min)` to `overtimeGraceMin: String(branch.overtime_grace_min)`. Update the corresponding form field label to "Overtime grace (min)" and its help text to "Overruns shorter than this are not reported."

In `apps/web/lib/test-helpers/db.ts:76,90`, `apps/web/lib/services/punch.test.ts:17,35,110` and `apps/web/lib/services/trip.test.ts:86`, rename the property.

- [ ] **Step 5: Update the integration test**

In `apps/web/lib/services/admin-branches.integration.test.ts`, change lines 40 and 43 to read `overtime_grace_min`, and change the request body field that sets it to `overtimeGraceMin: 20`.

- [ ] **Step 6: Verify**

Run:

```bash
pnpm -r typecheck && pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts"
```

Expected: typecheck passes, 150 unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(branch): rename absent_grace_min to overtime_grace_min

The field was dead - written by the branch screen, read by nothing.
It now carries the overtime notification threshold."
```

---

### Task 2: Additive schema for hours-based shifts

Adds every new field and leaves the old ones in place, so the tree stays green while consumers are rewired. Task 12 removes the old ones.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260815130000_hours_based_shifts/migration.sql`

**Interfaces:**
- Consumes: Task 1's `overtime_grace_min`.
- Produces: `Schedule.shift_min: number | null`, `ScheduleOverride.shift_min: number | null`, `LeaveRequest.shift_min: number | null`, `OverrideKind.HOURS_CHANGE`, `PenaltyKind.SHORTFALL`, model `OvertimeDecision`, enum `OvertimeDecisionKind`.

- [ ] **Step 1: Add the new schema fields**

In `packages/db/prisma/schema.prisma`, add `HOURS_CHANGE` to `OverrideKind` and `SHORTFALL` to `PenaltyKind`, keeping the existing values for now:

```prisma
enum OverrideKind {
  DAY_OFF
  TIME_CHANGE
  HOURS_CHANGE
}

enum PenaltyKind {
  LATE
  EARLY_LEAVE
  SHORTFALL
}

enum OvertimeDecisionKind {
  ACCEPTED
  REVOKED
}
```

Add `shift_min Int?` to `Schedule`, `ScheduleOverride` and `LeaveRequest`. Add the new model:

```prisma
// The owner has reviewed a day's overtime. No row means pending, and pending
// overtime is already paid - pairHours pays every minute worked. REVOKED makes
// payroll subtract that day's excess.
model OvertimeDecision {
  id         String               @id @default(cuid())
  user_id    String
  user       User                 @relation(fields: [user_id], references: [id])
  date       DateTime             @db.Date
  decision   OvertimeDecisionKind
  reason     String?
  decided_by String
  created_at DateTime             @default(now())

  @@unique([user_id, date])
  @@index([user_id, date])
}
```

Add `overtimeDecisions OvertimeDecision[]` to the `User` model's relation list, alongside the existing `penaltyWaivers` / `penaltyAcks` relations.

- [ ] **Step 2: Write the migration with backfill**

Create `packages/db/prisma/migrations/20260815130000_hours_based_shifts/migration.sql`:

```sql
ALTER TYPE "OverrideKind" ADD VALUE 'HOURS_CHANGE';
ALTER TYPE "PenaltyKind" ADD VALUE 'SHORTFALL';

CREATE TYPE "OvertimeDecisionKind" AS ENUM ('ACCEPTED', 'REVOKED');

ALTER TABLE "Schedule" ADD COLUMN "shift_min" INTEGER;
ALTER TABLE "ScheduleOverride" ADD COLUMN "shift_min" INTEGER;
ALTER TABLE "LeaveRequest" ADD COLUMN "shift_min" INTEGER;

-- Backfill from the clock window. An end at or before the start is an overnight
-- shift, so it lands on the next day.
UPDATE "Schedule" SET "shift_min" =
  ((EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
 - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
 + 1440) % 1440;

UPDATE "ScheduleOverride" SET "shift_min" =
  ((EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
 - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
 + 1440) % 1440
WHERE "start_time" IS NOT NULL AND "end_time" IS NOT NULL;

UPDATE "LeaveRequest" SET "shift_min" =
  ((EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
 - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
 + 1440) % 1440
WHERE "start_time" IS NOT NULL AND "end_time" IS NOT NULL;

ALTER TABLE "Schedule" ADD CONSTRAINT schedule_shift_min_chk
  CHECK ("shift_min" IS NULL OR ("shift_min" >= 0 AND "shift_min" <= 1440));
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT override_shift_min_chk
  CHECK ("shift_min" IS NULL OR ("shift_min" >= 0 AND "shift_min" <= 1440));
ALTER TABLE "LeaveRequest" ADD CONSTRAINT leave_shift_min_chk
  CHECK ("shift_min" IS NULL OR ("shift_min" >= 0 AND "shift_min" <= 1440));

CREATE TABLE "OvertimeDecision" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "date"       DATE NOT NULL,
  "decision"   "OvertimeDecisionKind" NOT NULL,
  "reason"     TEXT,
  "decided_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OvertimeDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OvertimeDecision_user_id_date_key" ON "OvertimeDecision"("user_id", "date");
CREATE INDEX "OvertimeDecision_user_id_date_idx" ON "OvertimeDecision"("user_id", "date");

ALTER TABLE "OvertimeDecision" ADD CONSTRAINT "OvertimeDecision_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

Note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on older Postgres. If `migrate deploy` rejects it, split the two `ALTER TYPE` lines into their own earlier migration directory.

- [ ] **Step 3: Apply and regenerate**

Run:

```bash
pnpm --filter db exec prisma migrate deploy && pnpm --filter db db:generate
```

Expected: migration applies cleanly.

- [ ] **Step 4: Verify the backfill**

Run:

```bash
pnpm --filter db exec prisma studio
```

Confirm each `Schedule` row's `shift_min` equals its window length — a 09:00–18:00 row is 540. Close studio. If there are no rows, seed first with `pnpm --filter db db:seed`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm -r typecheck
git add -A && git commit -m "feat(db): add shift_min, overtime decisions and SHORTFALL kind

Additive only - the clock-window columns stay until consumers are
rewired, so the tree stays green in between. shift_min is backfilled
from the existing window, treating end <= start as overnight."
```

---

### Task 3: `coverage.ts` — the single source of truth

**Files:**
- Create: `apps/web/lib/services/coverage.ts`
- Test: `apps/web/lib/services/coverage.test.ts`

**Interfaces:**
- Consumes: `inBeirut`, `beirutWeekday` from the `time` package.
- Produces:
  - `interface PunchLite { kind: 'IN' | 'OUT'; at: Date }`
  - `interface OverrideLite { kind: 'DAY_OFF' | 'HOURS_CHANGE'; shift_min: number | null }`
  - `interface DayCoverage { date: string; requiredMin: number; workedMin: number; deltaMin: number; closed: boolean; lastPunchAt: Date }`
  - `function computeCoverage(args: { punches: PunchLite[]; shiftMinByWeekday: Map<number, number>; overridesByDate: Map<string, OverrideLite> }): DayCoverage[]`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/services/coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCoverage, type PunchLite } from './coverage';

const utc = (iso: string) => new Date(iso);
// 2026-08-17 is a Monday in Beirut (UTC+3 in August).
const MON = 1;

function punches(...pairs: Array<[string, 'IN' | 'OUT']>): PunchLite[] {
  return pairs.map(([iso, kind]) => ({ kind, at: utc(iso) }));
}

describe('computeCoverage', () => {
  it('attributes an overnight shift wholly to the check-in day', () => {
    // 21:00 Mon Beirut = 18:00Z Mon; 07:00 Tue Beirut = 04:00Z Tue.
    const out = computeCoverage({
      punches: punches(['2026-08-17T18:00:00Z', 'IN'], ['2026-08-18T04:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-08-17');
    expect(out[0]!.workedMin).toBe(600);
    expect(out[0]!.requiredMin).toBe(480);
    expect(out[0]!.deltaMin).toBe(120);
    expect(out[0]!.closed).toBe(true);
  });

  it('sums multiple in/out pairs on the same day', () => {
    const out = computeCoverage({
      punches: punches(
        ['2026-08-17T05:00:00Z', 'IN'],
        ['2026-08-17T08:00:00Z', 'OUT'],
        ['2026-08-17T09:00:00Z', 'IN'],
        ['2026-08-17T12:00:00Z', 'OUT'],
      ),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out[0]!.workedMin).toBe(360);
    expect(out[0]!.deltaMin).toBe(-120);
  });

  it('leaves a day unclosed when a check-in has no checkout', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out[0]!.closed).toBe(false);
    expect(out[0]!.workedMin).toBe(0);
  });

  it('lets an HOURS_CHANGE override beat the weekday value', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T09:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map([['2026-08-17', { kind: 'HOURS_CHANGE', shift_min: 240 }]]),
    });
    expect(out[0]!.requiredMin).toBe(240);
    expect(out[0]!.deltaMin).toBe(0);
  });

  it('treats a DAY_OFF override as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map([['2026-08-17', { kind: 'DAY_OFF', shift_min: null }]]),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('treats an unscheduled weekday as zero required', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T05:00:00Z', 'IN'], ['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map(),
      overridesByDate: new Map(),
    });
    expect(out[0]!.requiredMin).toBe(0);
    expect(out[0]!.deltaMin).toBe(180);
  });

  it('ignores a checkout with no preceding check-in', () => {
    const out = computeCoverage({
      punches: punches(['2026-08-17T08:00:00Z', 'OUT']),
      shiftMinByWeekday: new Map([[MON, 480]]),
      overridesByDate: new Map(),
    });
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web exec vitest run lib/services/coverage.test.ts`
Expected: FAIL — cannot resolve `./coverage`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/services/coverage.ts`:

```ts
import { inBeirut, beirutWeekday } from 'time';

export interface PunchLite {
  kind: 'IN' | 'OUT';
  at: Date;
}

export interface OverrideLite {
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  shift_min: number | null;
}

export interface DayCoverage {
  date: string; // YYYY-MM-DD (Beirut)
  requiredMin: number;
  workedMin: number;
  deltaMin: number; // worked - required; negative is a shortfall
  closed: boolean; // false while a check-in has no matching checkout
  lastPunchAt: Date; // used to resolve the rate in force that day
}

/**
 * How many minutes each day owed and how many were actually covered.
 * Pure - no DB. A shift belongs to the Beirut day the employee checked IN, so
 * an overnight shift needs no special casing: it is simply that day's shift.
 */
export function computeCoverage(args: {
  punches: PunchLite[];
  shiftMinByWeekday: Map<number, number>;
  overridesByDate: Map<string, OverrideLite>;
}): DayCoverage[] {
  const sorted = [...args.punches].sort((a, b) => a.at.getTime() - b.at.getTime());

  const workedByDate = new Map<string, number>();
  const lastPunchByDate = new Map<string, Date>();
  // The weekday must come from the ARRIVAL, not the closing punch: an overnight
  // shift closes on the next calendar day, which is a different weekday.
  const arrivalByDate = new Map<string, Date>();
  const openDates = new Set<string>();

  let openIn: PunchLite | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p;
      continue;
    }
    if (!openIn) continue; // checkout with no arrival - ignore, as payout does
    const date = inBeirut(openIn.at).date;
    const minutes = Math.max(0, Math.floor((p.at.getTime() - openIn.at.getTime()) / 60_000));
    workedByDate.set(date, (workedByDate.get(date) ?? 0) + minutes);
    lastPunchByDate.set(date, p.at);
    if (!arrivalByDate.has(date)) arrivalByDate.set(date, openIn.at);
    openIn = null;
  }
  if (openIn) {
    const date = inBeirut(openIn.at).date;
    openDates.add(date);
    if (!workedByDate.has(date)) workedByDate.set(date, 0);
    lastPunchByDate.set(date, openIn.at);
    if (!arrivalByDate.has(date)) arrivalByDate.set(date, openIn.at);
  }

  const days: DayCoverage[] = [];
  for (const [date, workedMin] of workedByDate) {
    const lastPunchAt = lastPunchByDate.get(date)!;
    const override = args.overridesByDate.get(date);

    let requiredMin: number;
    if (override?.kind === 'DAY_OFF') {
      requiredMin = 0;
    } else if (override?.kind === 'HOURS_CHANGE' && override.shift_min !== null) {
      requiredMin = override.shift_min;
    } else {
      requiredMin = args.shiftMinByWeekday.get(beirutWeekday(arrivalByDate.get(date)!)) ?? 0;
    }

    days.push({
      date,
      requiredMin,
      workedMin,
      deltaMin: workedMin - requiredMin,
      closed: !openDates.has(date),
      lastPunchAt,
    });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web exec vitest run lib/services/coverage.test.ts`
Expected: PASS, 7 tests.

The overnight test is the one that matters here. It fails if the weekday is resolved from `lastPunchAt` instead of the arrival, because the closing punch lands on Tuesday while the shift is Monday's — the lookup would miss and return 0 required minutes. `arrivalByDate` exists for exactly that reason.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/services/coverage.ts apps/web/lib/services/coverage.test.ts
git commit -m "feat(coverage): compute owed vs worked minutes per day

Attributing a shift to its check-in day removes the overnight special
casing the penalty engine carried - 21:00 Mon to 07:00 Tue is simply
Monday, ten hours."
```

---

### Task 4: Shortfall penalties

Replaces the `LATE` and `EARLY_LEAVE` branches of `computePenalties` with one shortfall rule reading `DayCoverage`. Pricing is unchanged.

**Files:**
- Modify: `apps/web/lib/services/penalty.ts` (replace `computePenalties`, adapt `penaltiesForUser` and `pendingPenaltyNotices`)
- Modify: `apps/web/components/admin/AdminDashboard.tsx:27` (kind union only — the full rewording is Task 7)
- Test: `apps/web/lib/services/penalty.test.ts` (replace lateness/early-leave cases)

**Interfaces:**
- Consumes: `computeCoverage`, `DayCoverage`, `OverrideLite` from Task 3.
- Produces:
  - `type PenaltyKind = 'SHORTFALL'`
  - `interface PenaltyItem { date: string; kind: PenaltyKind; minutes: number; hours: number; rate_cent: number; amount_cent: number; waived: boolean }`
  - `function shortfallPenalties(args: { coverage: DayCoverage[]; rateChanges: RateChangeLite[]; waivedKeys: Set<string> }): PenaltyItem[]`
  - `penaltyHours`, `penaltiesForUser`, `sumActivePenaltiesCent`, `pendingPenaltyNotices` keep their existing names and signatures.

- [ ] **Step 1: Write the failing tests**

Replace the body of `apps/web/lib/services/penalty.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { penaltyHours, shortfallPenalties } from './penalty';
import type { DayCoverage } from './coverage';

const RATE = [{ rate_cent: 60_000, effective_from: new Date('2020-01-01T00:00:00Z') }];

function day(over: Partial<DayCoverage>): DayCoverage {
  return {
    date: '2026-08-17',
    requiredMin: 480,
    workedMin: 480,
    deltaMin: 0,
    closed: true,
    lastPunchAt: new Date('2026-08-17T14:00:00Z'),
    ...over,
  };
}

describe('penaltyHours', () => {
  it('forgives a shortfall under 15 minutes', () => {
    expect(penaltyHours(14)).toBe(0);
  });
  it('docks one hour at 15 minutes', () => {
    expect(penaltyHours(15)).toBe(1);
  });
  it('caps at 4 hours', () => {
    expect(penaltyHours(600)).toBe(4);
  });
});

describe('shortfallPenalties', () => {
  it('penalises covering less than required', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360, deltaMin: -120 })],
      rateChanges: RATE,
      waivedKeys: new Set(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('SHORTFALL');
    expect(items[0]!.minutes).toBe(120);
    expect(items[0]!.hours).toBe(4);
    expect(items[0]!.amount_cent).toBe(240_000);
  });

  it('ignores a day that met its hours', () => {
    expect(
      shortfallPenalties({ coverage: [day({})], rateChanges: RATE, waivedKeys: new Set() }),
    ).toHaveLength(0);
  });

  it('ignores overtime', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 600, deltaMin: 120 })],
        rateChanges: RATE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('does not judge an unclosed day', () => {
    expect(
      shortfallPenalties({
        coverage: [day({ workedMin: 0, deltaMin: -480, closed: false })],
        rateChanges: RATE,
        waivedKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  it('marks a waived day', () => {
    const items = shortfallPenalties({
      coverage: [day({ workedMin: 360, deltaMin: -120 })],
      rateChanges: RATE,
      waivedKeys: new Set(['2026-08-17|SHORTFALL']),
    });
    expect(items[0]!.waived).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web exec vitest run lib/services/penalty.test.ts`
Expected: FAIL — `shortfallPenalties` is not exported.

- [ ] **Step 3: Replace `computePenalties` with `shortfallPenalties`**

In `apps/web/lib/services/penalty.ts`:

Change the kind type and delete the now-unused `nextDateStr` helper, `ScheduleLite`, and the `scheduledToUtc` / `beirutWeekday` imports:

```ts
export type PenaltyKind = 'SHORTFALL';
```

Delete the whole `computePenalties` function (lines 53–159) and put in its place:

```ts
/**
 * Shortfall penalties from a day's coverage. Unclosed days are skipped - their
 * hours are unknowable until the missing punch is corrected.
 */
export function shortfallPenalties(args: {
  coverage: DayCoverage[];
  rateChanges: RateChangeLite[];
  waivedKeys: Set<string>; // `${date}|SHORTFALL`
}): PenaltyItem[] {
  const items: PenaltyItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.deltaMin >= 0) continue;
    const minutes = -day.deltaMin;
    const hours = penaltyHours(minutes);
    if (hours === 0) continue;
    const rate = rateAt(args.rateChanges, day.lastPunchAt);
    items.push({
      date: day.date,
      kind: 'SHORTFALL',
      minutes,
      hours,
      rate_cent: rate,
      amount_cent: hours * rate,
      waived: args.waivedKeys.has(`${day.date}|SHORTFALL`),
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}
```

Add the import at the top:

```ts
import { computeCoverage, type DayCoverage, type OverrideLite, type PunchLite } from './coverage';
```

and delete the file's own `PunchLite` and `OverrideLite` declarations, which now come from `coverage.ts`.

- [ ] **Step 4: Rewire `penaltiesForUser`**

In `penaltiesForUser`, change the `schedule.findMany` select to `{ weekday: true, shift_min: true }` and the `scheduleOverride.findMany` select to `{ date: true, kind: true, shift_min: true }`. Replace the map building and the final call:

```ts
  const shiftMinByWeekday = new Map<number, number>();
  for (const s of schedules) shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);

  const overridesByDate = new Map<string, OverrideLite>();
  for (const o of overrides) {
    if (o.kind !== 'DAY_OFF' && o.kind !== 'HOURS_CHANGE') continue;
    overridesByDate.set(o.date.toISOString().slice(0, 10), {
      kind: o.kind,
      shift_min: o.shift_min,
    });
  }

  const waivedKeys = new Set<string>();
  for (const w of waivers) waivedKeys.add(`${w.date.toISOString().slice(0, 10)}|${w.kind}`);

  const coverage = computeCoverage({
    punches: punches as PunchLite[],
    shiftMinByWeekday,
    overridesByDate,
  });
  return shortfallPenalties({
    coverage,
    rateChanges: rateChanges as RateChangeLite[],
    waivedKeys,
  });
```

- [ ] **Step 5: Rewire `pendingPenaltyNotices`**

Apply the same two select changes. Inside the per-user loop, replace the `schedulesByWeekday` / `overridesByDate` construction and the `computePenalties` call with the `computeCoverage` + `shortfallPenalties` pair from Step 4, keeping the surrounding `waived` / `since` / `ackedKeys` filtering exactly as it is. Delete the now-unused `now` plumbing: `computeCoverage` takes no `now`, so drop `now: opts.now` from the call but keep `opts.now` in the signature — Task 8 still passes it and removing it would break that caller.

- [ ] **Step 6: Keep the dashboard compiling**

Narrowing `PenaltyKind` breaks `apps/web/components/admin/AdminDashboard.tsx:27`, whose union still names the old kinds. Change that one union now so the tree stays green — the row wording and the overtime block are Task 7's job, not yours:

```ts
    penalties: { user_id: string; username: string; date: string; kind: 'SHORTFALL'; minutes: number; hours: number; amount_cent: number }[];
```

Change nothing else in that file.

- [ ] **Step 7: Run the tests**

Run:

```bash
pnpm --filter web exec vitest run lib/services/penalty.test.ts lib/services/coverage.test.ts && pnpm -r typecheck
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/services/penalty.ts apps/web/lib/services/penalty.test.ts apps/web/components/admin/AdminDashboard.tsx
git commit -m "feat(penalty): replace late/early-leave with a shortfall rule

Coverage against the day's required hours, priced by the existing
rule. Someone who arrives late but works the full shift is no longer
penalised, which is the point."
```

---

### Task 5: Overtime computation and its payroll effect

**Files:**
- Create: `apps/web/lib/services/overtime.ts`
- Test: `apps/web/lib/services/overtime.test.ts`
- Modify: `apps/web/lib/services/payout.ts:4-11,78-96,98-133`
- Test: `apps/web/lib/services/payout.test.ts`

**Interfaces:**
- Consumes: `DayCoverage` (Task 3), `rateAt` from `payout.ts`.
- Produces:
  - `interface OvertimeItem { date: string; overtimeMin: number; rate_cent: number; amount_cent: number; decision: 'ACCEPTED' | 'REVOKED' | null }`
  - `function computeOvertime(args: { coverage: DayCoverage[]; rateChanges: RateChangeLite[]; graceMin: number; decisionsByDate: Map<string, 'ACCEPTED' | 'REVOKED'> }): OvertimeItem[]`
  - `function sumRevokedOvertimeCent(items: OvertimeItem[]): number`
  - `async function overtimeForUser(userId: string, month: string, db: PrismaClient): Promise<OvertimeItem[]>`
  - `async function overtimeDeductionForUser(userId: string, month: string, db: PrismaClient): Promise<number>`
  - `PayoutForUserResult` gains `overtimeDeductionCent: number`.

**Known and accepted:** `overtime.ts` imports `rateAt` from `payout.ts` while
`payout.ts` imports `overtimeDeductionForUser` back. This is a circular import.
It mirrors the cycle already in the codebase between `payout.ts` and
`penalty.ts`, and works for the same reason — the calls happen at runtime, not
at module-init. The owner chose consistency with the existing pattern over
restructuring `rateAt` into a separate module. Do not "fix" it.

- [ ] **Step 1: Write the failing overtime tests**

Create `apps/web/lib/services/overtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeOvertime, sumRevokedOvertimeCent } from './overtime';
import type { DayCoverage } from './coverage';

const RATE = [{ rate_cent: 60_000, effective_from: new Date('2020-01-01T00:00:00Z') }];

function day(over: Partial<DayCoverage>): DayCoverage {
  return {
    date: '2026-08-17',
    requiredMin: 480,
    workedMin: 480,
    deltaMin: 0,
    closed: true,
    lastPunchAt: new Date('2026-08-17T14:00:00Z'),
    ...over,
  };
}

describe('computeOvertime', () => {
  it('stays silent inside the grace', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 10 })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('reports the whole overrun past the grace, not the excess over it', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 90 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(90);
    expect(items[0]!.amount_cent).toBe(90_000);
    expect(items[0]!.decision).toBeNull();
  });

  it('treats every minute of an unscheduled day as overtime', () => {
    const items = computeOvertime({
      coverage: [day({ requiredMin: 0, workedMin: 300, deltaMin: 300 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map(),
    });
    expect(items[0]!.overtimeMin).toBe(300);
  });

  it('does not judge an unclosed day', () => {
    expect(
      computeOvertime({
        coverage: [day({ deltaMin: 300, closed: false })],
        rateChanges: RATE,
        graceMin: 15,
        decisionsByDate: new Map(),
      }),
    ).toHaveLength(0);
  });

  it('carries the recorded decision', () => {
    const items = computeOvertime({
      coverage: [day({ deltaMin: 60 })],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', 'REVOKED']]),
    });
    expect(items[0]!.decision).toBe('REVOKED');
  });
});

describe('sumRevokedOvertimeCent', () => {
  it('counts only revoked days', () => {
    const items = computeOvertime({
      coverage: [
        day({ date: '2026-08-17', deltaMin: 60 }),
        day({ date: '2026-08-18', deltaMin: 60 }),
      ],
      rateChanges: RATE,
      graceMin: 15,
      decisionsByDate: new Map([['2026-08-17', 'REVOKED']]),
    });
    expect(sumRevokedOvertimeCent(items)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web exec vitest run lib/services/overtime.test.ts`
Expected: FAIL — cannot resolve `./overtime`.

- [ ] **Step 3: Write `overtime.ts`**

```ts
import { rateAt } from './payout';
import type { DayCoverage } from './coverage';

interface RateChangeLite {
  rate_cent: number;
  effective_from: Date;
}

export interface OvertimeItem {
  date: string; // YYYY-MM-DD (Beirut)
  overtimeMin: number;
  rate_cent: number;
  amount_cent: number; // already inside gross pay - pairHours pays every minute
  decision: 'ACCEPTED' | 'REVOKED' | null; // null means pending, and pending is paid
}

/**
 * Days that ran past their required hours by more than the branch grace. The
 * grace only decides whether the owner is told; a reported overrun reports all
 * of it, not the part above the grace.
 */
export function computeOvertime(args: {
  coverage: DayCoverage[];
  rateChanges: RateChangeLite[];
  graceMin: number;
  decisionsByDate: Map<string, 'ACCEPTED' | 'REVOKED'>;
}): OvertimeItem[] {
  const items: OvertimeItem[] = [];
  for (const day of args.coverage) {
    if (!day.closed) continue;
    if (day.deltaMin <= args.graceMin) continue;
    const rate = rateAt(args.rateChanges, day.lastPunchAt);
    items.push({
      date: day.date,
      overtimeMin: day.deltaMin,
      rate_cent: rate,
      amount_cent: Math.floor((day.deltaMin * rate) / 60),
      decision: args.decisionsByDate.get(day.date) ?? null,
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

export function sumRevokedOvertimeCent(items: OvertimeItem[]): number {
  return items.reduce((s, o) => (o.decision === 'REVOKED' ? s + o.amount_cent : s), 0);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter web exec vitest run lib/services/overtime.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the deduction to payout**

In `apps/web/lib/services/payout.ts`, add `overtimeDeductionCent: number;` to `PayoutForUserResult`. In `computePayoutFromRows`, add `overtimeDeductionCent?: number` to the args and change the two closing lines:

```ts
  const overtimeDeductionCent = args.overtimeDeductionCent ?? 0;
  const { hours, grossCent } = pairHours(args.punches, args.rateChanges);
  const netCent = grossCent + adjustmentsCent - advancesCent - penaltiesCent - overtimeDeductionCent;
  return { hours, grossCent, adjustmentsCent, advancesCent, penaltiesCent, overtimeDeductionCent, netCent };
```

In `payoutForUser`, load the user's overtime decisions for the month alongside the existing queries and pass the computed deduction through. Add to the `Promise.all`:

```ts
    db.overtimeDecision.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      select: { date: true, decision: true },
    }),
```

then before `computePayoutFromRows`, build the deduction using the same coverage the penalties used. Reuse `penaltiesForUser`'s loading by calling the new helper you add to `overtime.ts`:

```ts
export async function overtimeDeductionForUser(
  userId: string,
  month: string,
  db: PrismaClient,
): Promise<number> {
  const items = await overtimeForUser(userId, month, db);
  return sumRevokedOvertimeCent(items);
}
```

and `overtimeForUser`, which mirrors `penaltiesForUser` exactly — same `monthRangeUtc`, same punch / schedule / override / rate loads, plus the decision load and the branch's `overtime_grace_min` via `db.user.findUnique({ where: { id: userId }, select: { branch: { select: { overtime_grace_min: true } } } })`, defaulting to 15 when the user has no branch.

- [ ] **Step 6: Update the payout test**

In `apps/web/lib/services/payout.test.ts`, every assertion on the object returned by `computePayoutFromRows` now sees an extra key. Add one case:

```ts
it('subtracts revoked overtime from net', () => {
  const res = computePayoutFromRows({
    userId: 'u1',
    punches: [],
    rateChanges: [],
    adjustments: [],
    approvedAdvances: [],
    overtimeDeductionCent: 5_000,
  });
  expect(res.overtimeDeductionCent).toBe(5_000);
  expect(res.netCent).toBe(-5_000);
});
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts" && pnpm -r typecheck
git add -A && git commit -m "feat(overtime): report overruns and let payroll deduct revoked ones

Hours worked are already paid, so an overtime notice reports money
already committed. Revoking is what removes it."
```

---

### Task 6: Overtime decision API

**Files:**
- Create: `apps/web/app/api/admin/overtime/decision/route.ts`
- Test: `apps/web/lib/services/overtime.integration.test.ts`
- Modify: `API.md`

**Interfaces:**
- Consumes: `writeAuditLog`, `csrfFromRequest`, `readIdempotentResponse` / `storeIdempotentResponse`.
- Produces: `POST /api/admin/overtime/decision` accepting `{ userId, date, decision, reason? }`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/web/lib/services/overtime.integration.test.ts`, modelled on `apps/web/lib/services/admin-flags.integration.test.ts` — read that file first for the login and CSRF helpers it uses.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs } from '../test-helpers/auth';
import { cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

describe('POST /api/admin/overtime/decision', () => {
  beforeAll(async () => {
    await cleanDb();
    await seedTestBranch();
  });

  it('rejects a non-admin', async () => {
    const emp = await seedTestUser({ username: 'ot_emp', role: 'EMPLOYEE' });
    const session = await loginAs('ot_emp', 'change-me');
    const res = await fetch(`${BASE_URL}/api/admin/overtime/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'Idempotency-Key': 'ot-1',
      },
      body: JSON.stringify({ userId: emp.id, date: '2026-08-17', decision: 'REVOKED' }),
    });
    expect(res.status).toBe(403);
  });

  it('records a decision and is idempotent', async () => {
    const emp = await seedTestUser({ username: 'ot_emp2', role: 'EMPLOYEE' });
    const admin = await loginAs('owner', 'change-me');
    const body = JSON.stringify({ userId: emp.id, date: '2026-08-17', decision: 'REVOKED' });
    const headers = {
      'content-type': 'application/json',
      cookie: admin.cookieHeader,
      'x-csrf-token': admin.csrf,
      'Idempotency-Key': 'ot-2',
    };
    const first = await fetch(`${BASE_URL}/api/admin/overtime/decision`, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    const second = await fetch(`${BASE_URL}/api/admin/overtime/decision`, { method: 'POST', headers, body });
    expect(second.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Start the app, then run: `pnpm --filter web exec vitest run lib/services/overtime.integration.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Write the route**

Create `apps/web/app/api/admin/overtime/decision/route.ts`, following `apps/web/app/api/admin/penalties/waive/route.ts` as the pattern — open that file first and mirror its role check, CSRF check, idempotency handling and audit write. The body schema:

```ts
const Body = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decision: z.enum(['ACCEPTED', 'REVOKED']),
  reason: z.string().max(500).optional(),
});
```

The write is an upsert on the unique `(user_id, date)`:

```ts
  const dateOnly = new Date(`${body.date}T00:00:00.000Z`);
  await prisma.overtimeDecision.upsert({
    where: { user_id_date: { user_id: body.userId, date: dateOnly } },
    create: {
      user_id: body.userId,
      date: dateOnly,
      decision: body.decision,
      reason: body.reason ?? null,
      decided_by: adminId,
    },
    update: { decision: body.decision, reason: body.reason ?? null, decided_by: adminId },
  });
```

Audit action: `overtime.accepted` or `overtime.revoked`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter web exec vitest run lib/services/overtime.integration.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Document it in API.md**

Add the endpoint under the admin section, matching the surrounding format: method, path, role, body, responses.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): admin endpoint to accept or revoke a day's overtime"
```

---

### Task 7: Attention queue — three notice types

**Files:**
- Modify: `apps/web/app/api/admin/overview/route.ts:5,14-24,210-217,270`
- Modify: `apps/web/components/admin/AdminDashboard.tsx:27,138,300-345`

**Interfaces:**
- Consumes: `pendingPenaltyNotices` (Task 4), `computeOvertime` / `overtimeForUser` (Task 5).
- Produces: `attention.penalties[].kind` is `'SHORTFALL'`; new `attention.overtime[]` of `{ user_id, username, date, overtimeMin, amount_cent }`.

- [ ] **Step 1: Add overtime notices to the overview route**

In `apps/web/app/api/admin/overview/route.ts`, import the overtime helpers alongside `pendingPenaltyNotices`. After the existing `penalties` block at lines 210–217, add a matching `overtime` block scoped the same way — same `penaltyUsers` list, same `since` cutoff, filtering out any day that already has a decision. Add `overtime` to the response object at line 270.

- [ ] **Step 2: Fix the flag context wording**

Lines 14–24 describe flags using `scheduled_start` / `scheduled_end`, which no longer exist. Change the `WATCHED` case to read from `shift_min`:

```ts
      return c.shift_min
        ? `No punch at all - they were scheduled ${Math.round(c.shift_min / 60)}h.`
        : 'No punch at all on a scheduled day.';
```

and the `MISSED_CHECKOUT` case:

```ts
      return `Still clocked in past their ${Math.round((c.shift_min ?? 0) / 60)}h shift${late ? `, ${late} over` : ''}. Overtime, or forgot to punch out?`;
```

Update the `c` type on line 14 to `{ shift_min?: number; since_min?: number }`.

- [ ] **Step 3: Update the dashboard types**

In `apps/web/components/admin/AdminDashboard.tsx` line 27, change the penalty kind union to `'SHORTFALL'` and add the overtime array:

```ts
    penalties: { user_id: string; username: string; date: string; kind: 'SHORTFALL'; minutes: number; hours: number; amount_cent: number }[];
    overtime: { user_id: string; username: string; date: string; overtimeMin: number; amount_cent: number }[];
```

Add `att.overtime.length` to the count on line 138.

- [ ] **Step 4: Reword the penalty rows**

At line 312, the row currently reads `{p.date} · {p.minutes} min · {p.hours}h penalty`. Change it to say what was missed:

```tsx
{p.date} · short {formatMinutes(p.minutes)} · {p.hours}h docked
```

Add a small local helper above the component:

```tsx
function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```

Keep the existing Approve and Revoke buttons and their success messages exactly as they are — that wording was deliberate.

- [ ] **Step 5: Add the overtime rows**

Directly after the penalties block (which ends around line 345), add an overtime block using the same `Badge` / `act()` structure. Badge tone `warning`, label "Overtime". Row text:

```tsx
{o.date} · over by {formatMinutes(o.overtimeMin)} · {centsToUsd(o.amount_cent)} paid
```

Two buttons calling `/api/admin/overtime/decision`:

- Accept → `{ userId: o.user_id, date: o.date, decision: 'ACCEPTED' }`, success message ```Overtime stands — ${centsToUsd(o.amount_cent)} stays in ${o.username}'s pay.` ``
- Revoke → `{ ..., decision: 'REVOKED' }`, success message ```Overtime revoked — ${centsToUsd(o.amount_cent)} removed from ${o.username}'s pay.` ``

- [ ] **Step 6: Verify**

```bash
pnpm -r typecheck && pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts"
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(admin): shortfall and overtime notices in the attention queue

Each row says what happened and what it cost, matching the wording of
the other actions in the queue."
```

---

### Task 8: Schedule editor — hours instead of a window

**Files:**
- Modify: `apps/web/app/api/admin/schedules/[userId]/route.ts:8-16,61-87`
- Modify: `apps/web/app/(app)/admin/users/page.tsx:377,386-406,463`

**Interfaces:**
- Consumes: `Schedule.shift_min` (Task 2).
- Produces: `PUT /api/admin/schedules/[userId]` body `{ weeklySchedule: Array<{ weekday: number; shift_hours: number }> }`.

- [ ] **Step 1: Change the API contract**

In `apps/web/app/api/admin/schedules/[userId]/route.ts`, replace the `Body` schema:

```ts
const Body = z.object({
  weeklySchedule: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      shift_hours: z.number().min(0).max(24),
    }),
  ),
});
```

In the transaction, store minutes:

```ts
        data: body.weeklySchedule.map((s) => ({
          user_id: ctx.params.userId,
          weekday: s.weekday,
          shift_min: Math.round(s.shift_hours * 60),
        })),
```

In the audit `before`, map `shift_min` instead of the two times.

- [ ] **Step 2: Change the editor UI**

In `apps/web/app/(app)/admin/users/page.tsx`, update the fetch type on line 386 to `{ weekday: number; shift_min: number | null }[]`, and the day row construction on line 390:

```tsx
        return { wd: d.wd, name: d.name, working: !!s, hours: s?.shift_min != null ? s.shift_min / 60 : 8 };
```

Replace the two time inputs in each weekday row with one number input:

```tsx
<input
  type="number"
  min={0}
  max={24}
  step={0.5}
  value={d.hours}
  onChange={(e) => setHours(d.wd, Number(e.target.value))}
  className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-right"
  aria-label={`Shift hours on ${d.name}`}
/>
<span className="text-muted text-sm">hours</span>
```

Change the save payload on line 405:

```tsx
    const weeklySchedule = days.filter((d) => d.working).map((d) => ({ weekday: d.wd, shift_hours: d.hours }));
```

Show the weekly total beneath the rows — it is the number the owner is really setting:

```tsx
<p className="text-sm text-muted">
  Weekly total: {days.filter((d) => d.working).reduce((s, d) => s + d.hours, 0)}h
</p>
```

Update the override line at 463 to `Shift change → {o.shift_min != null ? `${o.shift_min / 60}h` : '—'}` and its `OverrideRow` interface at line 377 to carry `shift_min: number | null` and kind `'DAY_OFF' | 'HOURS_CHANGE'`.

- [ ] **Step 3: Verify the bounds hold**

Run the app and try to save 25 hours and -1. Both must be rejected — the input caps them, and the Zod schema rejects them if sent directly.

```bash
pnpm -r typecheck
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(admin): set a shift as hours per weekday

One number per day, 0-24, with the weekly total shown alongside."
```

---

### Task 9: Leave and hours-change requests

**Files:**
- Modify: `apps/web/lib/services/leave.ts:8-16,33-47,97-115,138-174`
- Modify: `apps/web/app/api/me/leave/route.ts`
- Modify: `apps/web/app/(app)/employee/leave/page.tsx`
- Modify: `apps/web/components/admin/AdminDashboard.tsx:29,391,412-413`
- Test: `apps/web/lib/services/leave.test.ts`

**Interfaces:**
- Consumes: `LeaveRequest.shift_min`, `OverrideKind.HOURS_CHANGE`.
- Produces: `RequestLeaveInput` gains `shiftHours?: number | null` and its `kind` becomes `'DAY_OFF' | 'HOURS_CHANGE'`.

- [ ] **Step 1: Update the service**

In `apps/web/lib/services/leave.ts`, change `RequestLeaveInput.kind` to `'DAY_OFF' | 'HOURS_CHANGE'`, replace `startTime`/`endTime` with `shiftHours?: number | null`, and replace the two regex validations at lines 33–34:

```ts
  if (input.shiftHours != null && (input.shiftHours < 0 || input.shiftHours > 24)) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
```

Store `shift_min: input.shiftHours != null ? Math.round(input.shiftHours * 60) : null`. In `decideLeave`, carry `shift_min: leave.shift_min` into both the `create` and `update` of the override upsert. In `LeaveSummary.upcoming`, replace the two time fields with `shift_min: number | null` and map it through.

- [ ] **Step 2: Update the request route and employee UI**

In `apps/web/app/api/me/leave/route.ts`, change the Zod body to accept `shiftHours` (0–24, optional) and `kind: z.enum(['DAY_OFF', 'HOURS_CHANGE'])`. In `apps/web/app/(app)/employee/leave/page.tsx`, replace the two time pickers with a single number input labelled "Hours needed", 0–24 step 0.5, shown only when the request kind is an hours change.

- [ ] **Step 3: Update the admin leave rows**

In `AdminDashboard.tsx` line 29, replace `start_time`/`end_time` in the `pendingLeaves` type with `shift_min: number | null`. Line 391 becomes:

```tsx
{l.kind === 'HOURS_CHANGE' && l.shift_min != null ? ` → ${l.shift_min / 60}h` : ''}
```

Lines 412–413 become:

```tsx
                                return l.kind === 'HOURS_CHANGE' && l.shift_min != null
                                  ? `Hours change approved — ${l.username} now works ${l.shift_min / 60}h (${days} updated on their schedule).`
```

Keep the rest of that success message untouched.

- [ ] **Step 4: Update the leave tests**

In `apps/web/lib/services/leave.test.ts`, replace every `TIME_CHANGE` with `HOURS_CHANGE` and every `startTime`/`endTime` pair with `shiftHours`. Add:

```ts
it('rejects more than 24 hours', async () => {
  const res = await requestLeave({
    userId: 'u1', kind: 'HOURS_CHANGE', startDate: '2099-01-01', endDate: '2099-01-01', shiftHours: 25,
  }, fakeDb);
  expect(res).toEqual({ ok: false, code: 'INVALID_INPUT' });
});
```

using whatever fake or stub the surrounding tests already use.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts" && pnpm -r typecheck
git add -A && git commit -m "feat(leave): request a number of hours instead of a time window"
```

---

### Task 10: Worker jobs — absence and missed checkout

**Files:**
- Modify: `apps/worker/src/jobs/watchedDetector.ts` (whole file)
- Modify: `apps/worker/src/jobs/missedCheckout.ts:29-61,83,95`
- Modify: `apps/worker/src/index.ts:24`
- Test: `apps/worker/src/jobs/watchedDetector.test.ts`, `apps/worker/src/jobs/missedCheckout.test.ts`

**Interfaces:**
- Consumes: `Schedule.shift_min`, `Branch.overtime_grace_min`.
- Produces: `runWatchedDetector` keeps its signature and result shape; `runMissedCheckout` likewise.

- [ ] **Step 1: Rewrite the absence detector**

`watchedDetector` becomes a look-back over the day that just closed. Replace the schedule query, the `effStart` / `triggerAt` logic and the punch window so that it:

1. computes `yesterday = todayInBeirut(now - 24h)` and its weekday,
2. loads schedules for that weekday with `shift_min` greater than zero,
3. skips users with a `DAY_OFF` override on that date,
4. flags users with zero punches in that Beirut day.

The flag context becomes `{ shift_min: s.shift_min, date: yesterday }`. Keep the existing one-flag-per-user-per-day guard exactly as it is, changing only the window it searches to yesterday's day bounds — the comment above it explains why it must not filter on `resolved_at`, and that reasoning still holds.

- [ ] **Step 2: Schedule it once a day**

In `apps/worker/src/index.ts` line 24, change the cron for `watchedDetector` from `*/1 * * * *` to `10 0 * * *` and update the printed schedule summary below it. Running after midnight is what makes a late-night start safe from being read as an absence.

- [ ] **Step 3: Retrigger missed checkout on elapsed hours**

In `missedCheckout.ts`, drop the `overnight` / `endsToday` logic at lines 29–61. The new rule: for each open check-in (an `IN` with no later `OUT`), flag when elapsed minutes exceed the user's `shift_min` for the check-in day plus their branch's `overtime_grace_min`. Load the branch through `s.user.branch`. Update the flag context at line 83 to `{ shift_min, over_min }` and the message at line 95 to:

```ts
        message: `Employee ${s.user.username}${s.user.branch ? `, ${s.user.branch.name}` : ''} is still clocked in past their ${Math.round(shiftMin / 60)}h shift. Overtime, or forgot to punch out?`,
```

- [ ] **Step 4: Update both job tests**

Rewrite `watchedDetector.test.ts` (6 tests) and `missedCheckout.test.ts` (4 tests) against the new triggers, keeping the existing fake-db style in those files. Cover: absence flagged for a scheduled day with no punches; not flagged when a punch exists; not flagged on a `DAY_OFF`; not flagged when `shift_min` is zero; missed checkout fires past shift plus grace and not before.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts" && pnpm -r typecheck
git add -A && git commit -m "feat(worker): absence check after midnight, checkout by elapsed hours

Judging absence once the day has closed means a driver who starts at
23:00 has already punched, so a late start cannot read as a no-show."
```

---

### Task 11: Driver session TTL

**Files:**
- Modify: `apps/web/lib/auth/session.ts:10-14,41-93`
- Modify: `apps/web/lib/auth/constants.ts:8`
- Modify: `apps/web/app/api/auth/login/route.ts`, `apps/web/app/api/auth/refresh/route.ts`
- Test: `apps/web/lib/auth/session.test.ts`

**Interfaces:**
- Produces: `function sessionExpiryFor(user: SessionUser, hasOpenPunch: boolean, now: Date): Date`. `ScheduleEntry`, `ResolvedSchedule` and `findScheduleInPast24h` are deleted.

- [ ] **Step 1: Rename the constant**

In `apps/web/lib/auth/constants.ts:8`, rename `SESSION_TTL_DRIVER_AFTER_SCHEDULE_MIN` to `SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN`, same value of 30.

- [ ] **Step 2: Replace the expiry rule**

In `apps/web/lib/auth/session.ts`, delete `ScheduleEntry`, `ResolvedSchedule` and `findScheduleInPast24h`, and replace `sessionExpiryFor`:

```ts
export function sessionExpiryFor(
  user: SessionUser,
  hasOpenPunch: boolean,
  now: Date,
): Date {
  if (user.role === 'DRIVER' && hasOpenPunch) {
    return addMinutes(now, SESSION_TTL_DRIVER_AFTER_CHECKOUT_MIN);
  }
  return addMinutes(now, SESSION_TTL_EMPLOYEE_MIN);
}
```

A driver who is checked in gets their session refreshed on every request, so it stays alive for as long as they are on shift and lapses 30 minutes after they punch out.

- [ ] **Step 3: Update both callers**

In `login/route.ts` and `refresh/route.ts`, replace the schedule load feeding `sessionExpiryFor` with an open-punch check:

```ts
  const lastPunch = await prisma.punch.findFirst({
    where: { user_id: user.id },
    orderBy: { at: 'desc' },
    select: { kind: true },
  });
  const hasOpenPunch = lastPunch?.kind === 'IN';
```

- [ ] **Step 4: Rewrite the session tests**

In `apps/web/lib/auth/session.test.ts`, delete the `findScheduleInPast24h` import and its cases (lines 85–110), and rewrite the `sessionExpiryFor` cases against the boolean: an employee always gets 120 minutes; a driver with no open punch gets 120; a driver with an open punch gets 30.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts" && pnpm -r typecheck
git add -A && git commit -m "feat(auth): keep driver sessions alive while checked in"
```

---

### Task 12: Drop the legacy columns and kinds

Only run this once every task above is merged and green. It is irreversible without a database restore.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260815140000_drop_clock_windows/migration.sql`
- Modify: `packages/db/prisma/seed.ts:23,97-102`
- Modify: `apps/web/lib/test-helpers/db.ts` (schedule seeding helper)

- [ ] **Step 1: Confirm nothing still reads the old fields**

Run:

```bash
grep -rn "start_time\|end_time\|TIME_CHANGE\|EARLY_LEAVE\|'LATE'" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules
```

Expected: no results. If any remain, fix them before continuing — this is the gate for the whole task.

- [ ] **Step 2: Make `shift_min` required and drop the rest**

In `schema.prisma`, change `Schedule.shift_min` to `Int` (non-null), remove `start_time` / `end_time` from all three models, and reduce the enums:

```prisma
enum OverrideKind {
  DAY_OFF
  HOURS_CHANGE
}

enum PenaltyKind {
  SHORTFALL
}
```

- [ ] **Step 3: Write the migration**

Create `packages/db/prisma/migrations/20260815140000_drop_clock_windows/migration.sql`:

```sql
-- Beta data: the owner has confirmed existing punches and penalties are
-- disposable. These deletes are irreversible without a restore.
DELETE FROM "PenaltyWaiver" WHERE "kind" IN ('LATE', 'EARLY_LEAVE');
DELETE FROM "PenaltyAck"    WHERE "kind" IN ('LATE', 'EARLY_LEAVE');
UPDATE "ScheduleOverride" SET "kind" = 'HOURS_CHANGE' WHERE "kind" = 'TIME_CHANGE';
UPDATE "LeaveRequest"     SET "kind" = 'HOURS_CHANGE' WHERE "kind" = 'TIME_CHANGE';

UPDATE "Schedule" SET "shift_min" = 0 WHERE "shift_min" IS NULL;
ALTER TABLE "Schedule" ALTER COLUMN "shift_min" SET NOT NULL;

ALTER TABLE "Schedule"         DROP COLUMN "start_time", DROP COLUMN "end_time";
ALTER TABLE "ScheduleOverride" DROP COLUMN "start_time", DROP COLUMN "end_time";
ALTER TABLE "LeaveRequest"     DROP COLUMN "start_time", DROP COLUMN "end_time";

ALTER TABLE "Schedule" DROP CONSTRAINT IF EXISTS schedule_time_chk;

ALTER TYPE "OverrideKind" RENAME TO "OverrideKind_old";
CREATE TYPE "OverrideKind" AS ENUM ('DAY_OFF', 'HOURS_CHANGE');
ALTER TABLE "ScheduleOverride" ALTER COLUMN "kind" TYPE "OverrideKind" USING "kind"::text::"OverrideKind";
ALTER TABLE "LeaveRequest"     ALTER COLUMN "kind" TYPE "OverrideKind" USING "kind"::text::"OverrideKind";
DROP TYPE "OverrideKind_old";

ALTER TYPE "PenaltyKind" RENAME TO "PenaltyKind_old";
CREATE TYPE "PenaltyKind" AS ENUM ('SHORTFALL');
ALTER TABLE "PenaltyWaiver" ALTER COLUMN "kind" TYPE "PenaltyKind" USING "kind"::text::"PenaltyKind";
ALTER TABLE "PenaltyAck"    ALTER COLUMN "kind" TYPE "PenaltyKind" USING "kind"::text::"PenaltyKind";
DROP TYPE "PenaltyKind_old";
```

- [ ] **Step 4: Update the seed and test helpers**

In `packages/db/prisma/seed.ts`, replace `DEFAULT_SCHEDULE` at line 23 with `const DEFAULT_SHIFT_MIN = 540;` and the `schedule.create` at lines 97–102 to write `shift_min: DEFAULT_SHIFT_MIN`. Apply the same change to whichever schedule helper `apps/web/lib/test-helpers/db.ts` exposes.

- [ ] **Step 5: Apply, reseed and verify everything**

```bash
pnpm --filter db exec prisma migrate deploy && pnpm --filter db db:generate && pnpm --filter db db:seed
pnpm -r typecheck
pnpm --filter web exec vitest run --exclude "**/*.integration.test.ts"
pnpm --filter web exec next build
```

Expected: all pass, build exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(db): drop clock-window columns and the old penalty kinds

Deletes LATE and EARLY_LEAVE waiver and ack rows. Authorised as beta
data by the owner; irreversible without a restore."
```

---

### Task 13: Documentation

**Files:**
- Modify: `SYSTEM_MAP.md`
- Modify: `README.md:7-14`
- Modify: `DEPLOY.md` (production checklist)

- [ ] **Step 1: Update SYSTEM_MAP.md**

Rewrite the scheduling and penalty sections: a shift is a number of hours per weekday; a shift belongs to its check-in day; shortfall replaces late and early-leave; overtime is reported past the branch grace and is paid unless revoked; absence is a notice with no automatic penalty.

- [ ] **Step 2: Update README.md**

In the Admin bullet at lines 7–10, replace "penalties, flags" with "shortfalls, overtime, flags". In the Employee bullet, "hours-change requests" still holds.

- [ ] **Step 3: Update the DEPLOY.md checklist**

Add one item: `[ ] Each employee's weekly shift hours set (a weekday with no hours means any work that day is overtime)`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: hours-based shifts, shortfall penalties and overtime review"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: data model → 1, 2, 12; coverage → 3; shortfall → 4; overtime → 5, 6; absence → 10; missed checkout → 10; driver sessions → 11; UI → 7, 8, 9; API → 6, 8, 9; testing → folded into each task; docs → 13.

**Known gap, deliberate.** The spec's "no cutover" decision means the schema keeps `shift_min` nullable from Task 2 until Task 12. Any row created in between with a null shift is treated as zero required hours, which makes every worked minute overtime. That is the correct reading and it is only reachable inside the implementation window.

**Type consistency.** `DayCoverage`, `PunchLite` and `OverrideLite` are declared once in `coverage.ts` (Task 3) and imported everywhere after. `PenaltyItem` keeps its existing shape with `kind` narrowed to `'SHORTFALL'`. `OvertimeItem` is declared in Task 5 and consumed unchanged in Tasks 6 and 7. `sessionExpiryFor` changes signature in Task 11 and both callers change in the same task.

**Bug caught during review, already fixed in the plan.** The first draft of `computeCoverage` resolved the weekday from `lastPunchAt`. For an overnight shift the closing punch is on the next calendar day, so a Monday 21:00–07:00 shift would have looked up Tuesday's hours, missed, and reported 0 required minutes — turning a full shift into pure overtime. `arrivalByDate` fixes it, and the overnight test in Step 1 is what catches a regression.

**Ordering constraint.** Task 12 is the only destructive step and it is gated on the grep in its Step 1 returning nothing. Tasks 1–11 each leave the tree green, so the work can stop between any two of them without a broken deploy.
