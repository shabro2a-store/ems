ALTER TABLE "LeaveRequest" RENAME COLUMN "shift_min" TO "off_min";
ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS leave_shift_min_chk;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT leave_off_min_chk
  CHECK ("off_min" IS NULL OR ("off_min" >= 0 AND "off_min" <= 1440));
