-- Drivers earn per completed trip on top of the hour. The current rate lives on
-- the user like hourly_rate_cent; the history that prices past months mirrors
-- RateChange. Defaults to zero, so adding it changes nobody's pay until the
-- owner sets a figure.
ALTER TABLE "User" ADD COLUMN "trip_rate_cent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TripRateChange" (
  "id"             TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  "rate_cent"      INTEGER NOT NULL,
  "effective_from" TIMESTAMP(3) NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TripRateChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TripRateChange_user_id_effective_from_idx" ON "TripRateChange"("user_id", "effective_from");
ALTER TABLE "TripRateChange" ADD CONSTRAINT "TripRateChange_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripRateChange" ADD CONSTRAINT triprate_amount_chk CHECK (rate_cent >= 0);
