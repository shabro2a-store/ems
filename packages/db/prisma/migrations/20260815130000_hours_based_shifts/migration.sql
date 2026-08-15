ALTER TYPE "OverrideKind" ADD VALUE 'HOURS_CHANGE';
ALTER TYPE "PenaltyKind" ADD VALUE 'SHORTFALL';

CREATE TYPE "OvertimeDecisionKind" AS ENUM ('ACCEPTED', 'REVOKED');

ALTER TABLE "Schedule" ADD COLUMN "shift_min" INTEGER;
ALTER TABLE "ScheduleOverride" ADD COLUMN "shift_min" INTEGER;
ALTER TABLE "LeaveRequest" ADD COLUMN "shift_min" INTEGER;

-- Backfill from the clock window. End after start is a same-day shift; end at or
-- before start wraps to the next day - so an equal start/end is a full 24h shift
-- (1440), not a zero-length one.
UPDATE "Schedule" SET "shift_min" =
  CASE
    WHEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       > (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    THEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    ELSE (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
       + 1440
  END;

UPDATE "ScheduleOverride" SET "shift_min" =
  CASE
    WHEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       > (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    THEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    ELSE (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
       + 1440
  END
WHERE "start_time" IS NOT NULL AND "end_time" IS NOT NULL;

UPDATE "LeaveRequest" SET "shift_min" =
  CASE
    WHEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       > (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    THEN (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
    ELSE (EXTRACT(HOUR FROM "end_time"::time) * 60 + EXTRACT(MINUTE FROM "end_time"::time))
       - (EXTRACT(HOUR FROM "start_time"::time) * 60 + EXTRACT(MINUTE FROM "start_time"::time))
       + 1440
  END
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
