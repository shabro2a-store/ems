-- Raw-SQL migration: CHECK constraints, partial unique + partial index on Trip, REVOKE on AuditLog.
-- Spec.md §6 / §9. Applied via prisma migrate dev (must actually run, not just exist).

ALTER TABLE "Schedule"
  ADD CONSTRAINT schedule_weekday_chk CHECK (weekday BETWEEN 0 AND 6);

ALTER TABLE "Schedule"
  ADD CONSTRAINT schedule_time_chk CHECK (start_time ~ '^\d{2}:\d{2}$' AND end_time ~ '^\d{2}:\d{2}$');

ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT leave_range_chk CHECK (end_date >= start_date);

ALTER TABLE "Adjustment"
  ADD CONSTRAINT adjustment_amount_chk CHECK (amount_cent >= 0);

ALTER TABLE "Adjustment"
  ADD CONSTRAINT adjustment_period_chk CHECK (EXTRACT(DAY FROM period) = 1);

CREATE UNIQUE INDEX trip_one_open ON "Trip"(driver_id) WHERE back_at IS NULL;

CREATE INDEX trip_open_by_branch ON "Trip"(branch_id) WHERE back_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app') THEN
    REVOKE UPDATE, DELETE ON "AuditLog" FROM ems_app;
  END IF;
END $$;