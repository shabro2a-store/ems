-- A trip closed by the system, not by a BACK the driver pressed. Mirrors
-- Punch.system_generated: an open trip gates every driver punch, so one that
-- was abandoned has to be closed by something, and the feed that shows
-- "returned from a trip" must not say that about a return nobody made.
-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "system_generated" BOOLEAN NOT NULL DEFAULT false;
