-- #43: the "driver out too long" alert is sent once per trip, not on every
-- 30-minute run. Trips already open are alerted at most once more.
ALTER TABLE "Trip" ADD COLUMN "stale_alerted_at" TIMESTAMP(3);
