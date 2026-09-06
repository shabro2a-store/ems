-- Per-employee working-day boundary, overriding the branch's. Null keeps the
-- branch's value, so every existing row behaves exactly as it does today.
ALTER TABLE "User" ADD COLUMN "day_start_hour" INTEGER;
