-- A check-in refused because an earlier shift was still open. Written only
-- after the geofence check has passed, so every row is proof the employee was
-- physically at their branch with acceptable GPS when the system turned them
-- away.

-- CreateTable
CREATE TABLE "BlockedPunchAttempt" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "open_in_at" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_m" INTEGER NOT NULL,
    "device_fp" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedPunchAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockedPunchAttempt_user_id_at_idx" ON "BlockedPunchAttempt"("user_id", "at");

-- CreateIndex
CREATE INDEX "BlockedPunchAttempt_branch_id_at_idx" ON "BlockedPunchAttempt"("branch_id", "at");

-- AddForeignKey
ALTER TABLE "BlockedPunchAttempt" ADD CONSTRAINT "BlockedPunchAttempt_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedPunchAttempt" ADD CONSTRAINT "BlockedPunchAttempt_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
