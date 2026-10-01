-- Overtime paid at each person's own rate from 2026-10-01 (the owner's rule).
-- Additive: a null overtime_rate_cent and no OvertimeRateChange rows mean the
-- hourly rate, so nobody's pay changes until the owner sets a rate.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "overtime_rate_cent" INTEGER;

-- CreateTable
CREATE TABLE "OvertimeRateChange" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rate_cent" INTEGER,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OvertimeRateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OvertimeRateChange_user_id_effective_from_key" ON "OvertimeRateChange"("user_id", "effective_from");

-- AddForeignKey
ALTER TABLE "OvertimeRateChange" ADD CONSTRAINT "OvertimeRateChange_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

