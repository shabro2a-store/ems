-- Indexes for the reads that walked a whole table or a whole index: the admin
-- overview, activity and punch lists and the payroll roster (Punch by time),
-- the trip review and receipt wipe (Trip by time), the watched and missed
-- checkout detectors (Flag by person and kind), the pending advance and leave
-- queues, and the per-date schedule overrides.
CREATE INDEX "Punch_at_idx" ON "Punch"("at");
CREATE INDEX "Trip_out_at_idx" ON "Trip"("out_at");
CREATE INDEX "Flag_user_id_kind_idx" ON "Flag"("user_id", "kind");
CREATE INDEX "Advance_status_idx" ON "Advance"("status");
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");
CREATE INDEX "ScheduleOverride_date_idx" ON "ScheduleOverride"("date");

-- Each duplicated the index its @@unique([user_id, date]) already builds.
DROP INDEX "OvertimeDecision_user_id_date_idx";
DROP INDEX "BlockedCreditDecision_user_id_date_idx";

-- The ring repeater runs every five seconds and wants only the calls nobody has
-- answered yet. A partial index holds just those rows, so the read stays small
-- however many answered calls pile up. Prisma cannot express a partial index;
-- it lives only here (like trip_one_open).
CREATE INDEX driver_call_unanswered ON "DriverCall"(created_at) WHERE acknowledged_at IS NULL;
