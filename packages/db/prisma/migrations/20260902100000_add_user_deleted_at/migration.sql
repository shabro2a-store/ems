-- A retired account: the person is gone from every present-tense screen, cannot
-- log in and cannot punch, but the row stays so the punches, advances and
-- penalties that point at it still resolve. Payroll for a month they worked
-- still lists them; the month after they are simply absent, because they have
-- no records in it.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deleted_at" TIMESTAMP(3);
CREATE INDEX "User_deleted_at_idx" ON "User"("deleted_at");
