-- Reference-only figure the owner sets per employee to eyeball against actual
-- payroll on the admin payroll screen. Never read by any payout calculation.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "expected_monthly_salary_cent" INTEGER;
