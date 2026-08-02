-- An admin acknowledging an auto-computed penalty: the penalty still applies
-- (that is what separates this from PenaltyWaiver) but the notice leaves the
-- attention queue, which would otherwise recompute it on every poll.

-- CreateTable
CREATE TABLE "PenaltyAck" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "PenaltyKind" NOT NULL,
    "acknowledged_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PenaltyAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PenaltyAck_user_id_date_kind_key" ON "PenaltyAck"("user_id", "date", "kind");

-- CreateIndex
CREATE INDEX "PenaltyAck_user_id_date_idx" ON "PenaltyAck"("user_id", "date");

-- AddForeignKey
ALTER TABLE "PenaltyAck" ADD CONSTRAINT "PenaltyAck_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
