-- The grace now governs both directions of missing a day's hours: an overrun
-- smaller than it raises no overtime notice, and a shortfall smaller than it
-- incurs no penalty. The old name only described the overrun, and a name that
-- outlives its meaning is how this system has repeatedly gone wrong.
ALTER TABLE "Branch" RENAME COLUMN "overtime_grace_min" TO "shift_grace_min";
