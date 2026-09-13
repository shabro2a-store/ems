-- Every trip now starts with a live photo of the order's receipt, and the
-- owner reviews a driver's day of photos beside the cash that driver handed
-- in. The photo bytes get their own table so listing trips never drags them
-- along, and they are wiped a week on; the trip keeps receipt_taken_at as the
-- record that there was one. Nothing here touches history: the columns are
-- null on every trip made before receipts existed.
ALTER TABLE "Trip"
  ADD COLUMN "receipt_taken_at" TIMESTAMP(3),
  ADD COLUMN "denied_at"        TIMESTAMP(3),
  ADD COLUMN "denied_by"        TEXT,
  ADD COLUMN "denied_reason"    TEXT,
  ADD COLUMN "reviewed_at"      TIMESTAMP(3),
  ADD COLUMN "reviewed_by"      TEXT;

CREATE TABLE "TripReceipt" (
  "trip_id"    TEXT NOT NULL,
  "mime"       TEXT NOT NULL,
  "bytes"      BYTEA NOT NULL,
  "size"       INTEGER NOT NULL,
  "width"      INTEGER NOT NULL,
  "height"     INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TripReceipt_pkey" PRIMARY KEY ("trip_id")
);
ALTER TABLE "TripReceipt" ADD CONSTRAINT "TripReceipt_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
