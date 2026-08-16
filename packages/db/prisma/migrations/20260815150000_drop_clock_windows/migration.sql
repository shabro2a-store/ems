-- Beta data: the owner has confirmed existing punches and penalties are
-- disposable. These deletes are irreversible without a restore. They must run
-- before the enums are recreated, or the cast below fails on a value the new
-- type no longer has.
DELETE FROM "PenaltyWaiver" WHERE "kind" IN ('LATE', 'EARLY_LEAVE');
DELETE FROM "PenaltyAck"    WHERE "kind" IN ('LATE', 'EARLY_LEAVE');
UPDATE "ScheduleOverride" SET "kind" = 'HOURS_CHANGE' WHERE "kind" = 'TIME_CHANGE';
UPDATE "LeaveRequest"     SET "kind" = 'HOURS_CHANGE' WHERE "kind" = 'TIME_CHANGE';

UPDATE "Schedule" SET "shift_min" = 0 WHERE "shift_min" IS NULL;
ALTER TABLE "Schedule" ALTER COLUMN "shift_min" SET NOT NULL;

-- Dropped ahead of the columns it reads. Postgres would cascade it away with
-- the column anyway; doing it explicitly keeps the intent in the history.
ALTER TABLE "Schedule" DROP CONSTRAINT IF EXISTS schedule_time_chk;

ALTER TABLE "Schedule"         DROP COLUMN "start_time", DROP COLUMN "end_time";
ALTER TABLE "ScheduleOverride" DROP COLUMN "start_time", DROP COLUMN "end_time";
ALTER TABLE "LeaveRequest"     DROP COLUMN "start_time", DROP COLUMN "end_time";

-- Postgres cannot drop a value from an enum in place. Every column still on the
-- old type has to be cast across before the old type can be dropped.
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
