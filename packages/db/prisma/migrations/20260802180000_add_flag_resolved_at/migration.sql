-- Split "an alert was sent" from "a human dealt with it". They were both
-- notified_at, which caused two visible bugs: the 23:30 sweep dropped WATCHED
-- flags off the attention list by merely alerting about them, and dismissing a
-- flag made watchedDetector's dedup guard stop matching it, so the cron created
-- a fresh duplicate on its next run a minute later.

-- AlterTable
ALTER TABLE "Flag" ADD COLUMN "resolved_at" TIMESTAMP(3);

-- Preserve what admins currently see. Until now the UI treated notified_at as
-- the dismissal marker, so every flag already stamped is one they consider done.
-- Copying it forward means nothing hidden today reappears after this deploy.
UPDATE "Flag" SET "resolved_at" = "notified_at" WHERE "notified_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Flag_resolved_at_idx" ON "Flag"("resolved_at");
