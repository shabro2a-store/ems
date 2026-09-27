-- The weekly hours get a history. An edit used to delete the person's rows and
-- write new ones, so every past day - paid months included - was judged against
-- the hours as they are now. An edit now adds rows from the day it is made, and
-- each day is judged against the row in force on it (scheduleRowOn).
--
-- Every existing row becomes "in force since forever": what the hours were
-- before today cannot be recovered, and these are the hours payroll has been
-- using for every past day anyway, so nothing already computed moves.
ALTER TABLE "Schedule" ADD COLUMN "effective_from" DATE NOT NULL DEFAULT '1970-01-01';

DROP INDEX "Schedule_user_id_weekday_key";
CREATE UNIQUE INDEX "Schedule_user_id_weekday_effective_from_key" ON "Schedule"("user_id", "weekday", "effective_from");
