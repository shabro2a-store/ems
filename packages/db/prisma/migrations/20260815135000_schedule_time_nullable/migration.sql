-- Task 8 needs the write path to stop supplying start_time/end_time. Task 12
-- still owns the full removal (columns + enums + seed data) once Tasks 9-11
-- stop reading these two columns too - this only relaxes NOT NULL so Task 8's
-- insert is legal in the meantime. Mirrors the nullability ScheduleOverride
-- and LeaveRequest already have on the identical columns.
ALTER TABLE "Schedule" ALTER COLUMN "start_time" DROP NOT NULL;
ALTER TABLE "Schedule" ALTER COLUMN "end_time" DROP NOT NULL;
