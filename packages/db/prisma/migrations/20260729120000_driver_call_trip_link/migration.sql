-- Link a caller ring to the trip it dispatched. A driver can only go "out on
-- order" against a recent, unconsumed call; starting the trip stamps trip_id.

-- AlterTable
ALTER TABLE "DriverCall" ADD COLUMN "trip_id" TEXT;

-- CreateIndex (find a driver's unconsumed recent call quickly)
CREATE INDEX "DriverCall_driver_id_trip_id_idx" ON "DriverCall"("driver_id", "trip_id");
