-- The owner's ruling on one day's blocked-time credit. No row means pending,
-- and pending credit grants nothing: ACCEPTED is what pays it, REVOKED moves no
-- money at all. The inverse of OvertimeDecision, where pending is already paid.

-- CreateEnum
CREATE TYPE "CreditDecisionKind" AS ENUM ('ACCEPTED', 'REVOKED');

-- CreateTable
CREATE TABLE "BlockedCreditDecision" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "decision" "CreditDecisionKind" NOT NULL,
    "credited_min" INTEGER,
    "reason" TEXT,
    "decided_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedCreditDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockedCreditDecision_user_id_date_idx" ON "BlockedCreditDecision"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedCreditDecision_user_id_date_key" ON "BlockedCreditDecision"("user_id", "date");

-- AddForeignKey
ALTER TABLE "BlockedCreditDecision" ADD CONSTRAINT "BlockedCreditDecision_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
