-- Penalties (late / early-leave) are computed on the fly from schedule vs punches.
-- Only the admin "remove penalty" action is persisted, as a PenaltyWaiver.

-- CreateEnum
CREATE TYPE "PenaltyKind" AS ENUM ('LATE', 'EARLY_LEAVE');

-- CreateTable
CREATE TABLE "PenaltyWaiver" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "PenaltyKind" NOT NULL,
    "reason" TEXT,
    "waived_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PenaltyWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PenaltyWaiver_user_id_date_kind_key" ON "PenaltyWaiver"("user_id", "date", "kind");

-- CreateIndex
CREATE INDEX "PenaltyWaiver_user_id_date_idx" ON "PenaltyWaiver"("user_id", "date");

-- AddForeignKey
ALTER TABLE "PenaltyWaiver" ADD CONSTRAINT "PenaltyWaiver_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
