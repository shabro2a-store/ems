-- The day's penalty minutes as they stood when the owner ruled on them. A
-- waiver or an ack is keyed by calendar day, but the penalty moves whenever a
-- punch is corrected, so the ruling has to name the amount it was made
-- against. Nullable and read as stale, so a row written before this column
-- existed returns its day to the review queue instead of needing a backfill.
-- AlterTable
ALTER TABLE "PenaltyWaiver" ADD COLUMN     "penalty_min" INTEGER;

-- AlterTable
ALTER TABLE "PenaltyAck" ADD COLUMN     "penalty_min" INTEGER;
