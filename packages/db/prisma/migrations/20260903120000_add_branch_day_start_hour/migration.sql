-- The hour the working day begins, for branches whose shifts sit on the
-- midnight line. 0 keeps the calendar day, which is what every branch has today
-- and what shiftDateOf() reproduces exactly, so this changes nothing until a
-- branch is given a different hour.
-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "day_start_hour" INTEGER NOT NULL DEFAULT 0;
