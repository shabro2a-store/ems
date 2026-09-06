-- The working-day boundary stops being a branch setting.
--
-- A branch cannot hold one: every branch that uses it has both a night worker
-- who needs it and day staff whom it silently files into the previous day - and
-- the previous month. Leaving it on the branch means the DEFAULT is the harmful
-- one, so every new hire at those branches inherits the trap and the owner has
-- to remember to turn it off for each of them, forever.
--
-- After this the person is the only thing that carries a boundary, and null - a
-- new account, or anyone never configured - means midnight, which cannot move a
-- shift anywhere.
--
-- Conservative on the way through: the branch value is copied onto exactly the
-- people who have actually clocked in before it, so nobody who currently relies
-- on it loses it in the deploy. Everyone who has never once started before the
-- boundary has never been affected by it and stays at midnight, permanently.
UPDATE "User" u
SET day_start_hour = b.day_start_hour
FROM "Branch" b
WHERE u.branch_id = b.id
  AND u.day_start_hour IS NULL
  AND COALESCE(b.day_start_hour, 0) <> 0
  AND EXISTS (
    SELECT 1 FROM "Punch" p
    WHERE p.user_id = u.id
      AND p.kind = 'IN'
      AND p.at > now() - interval '120 days'
      AND EXTRACT(HOUR FROM (p.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Beirut')) < b.day_start_hour
  );
