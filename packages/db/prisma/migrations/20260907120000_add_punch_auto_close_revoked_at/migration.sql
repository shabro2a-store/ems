-- The owner's override of a checkout the system wrote. Set on the IN punch, so
-- the sweep and the clock-out path can both see "leave this arrival alone"
-- without having to look for a deleted OUT that is no longer there.
ALTER TABLE "Punch" ADD COLUMN "auto_close_revoked_at" TIMESTAMP(3);
