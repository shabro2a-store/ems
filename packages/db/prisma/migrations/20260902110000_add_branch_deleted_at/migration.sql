-- A closed branch: gone from every present-tense screen and from the list you
-- assign staff to, but the row stays so the punches and trips that point at it
-- still resolve. Payroll for a month it was open still shows that month's work;
-- the month after it is simply absent, because nothing happened there.
-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "deleted_at" TIMESTAMP(3);
