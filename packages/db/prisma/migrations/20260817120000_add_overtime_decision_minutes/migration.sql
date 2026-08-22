-- The day's overtime minutes as they stood when the owner ruled on them. A
-- decision is keyed by calendar day, but the day's overtime can grow after the
-- ruling, so the ruling has to name the amount it was made against. Nullable
-- and read as stale, so any row written before this column existed deducts
-- nothing and returns to the review queue instead of needing a backfill.
-- AlterTable
ALTER TABLE "OvertimeDecision" ADD COLUMN     "overtime_min" INTEGER;
