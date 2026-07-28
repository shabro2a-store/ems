-- Caller role (POS cashier who rings drivers) + the ring signal.

-- AlterEnum: add CALLER. The new value is not used elsewhere in this migration,
-- so it is safe within the migration transaction (Postgres 12+).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CALLER';

-- CreateTable
CREATE TABLE "DriverCall" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "caller_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "DriverCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverCall_driver_id_created_at_idx" ON "DriverCall"("driver_id", "created_at");

-- AddForeignKey
ALTER TABLE "DriverCall" ADD CONSTRAINT "DriverCall_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCall" ADD CONSTRAINT "DriverCall_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
