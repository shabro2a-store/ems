-- Lets one person clock in and out at ANY active branch, not only their own,
-- and be dispatched from whichever branch rang them. Off by default, so every
-- account keeps the single-branch rule until the owner grants it.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "can_roam_branches" BOOLEAN NOT NULL DEFAULT false;
