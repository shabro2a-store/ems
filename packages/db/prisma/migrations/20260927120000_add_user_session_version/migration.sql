-- Bumped whenever a person's existing sessions must end: signing out, a
-- password reset or change, a change of role, retirement. Every token carries
-- the version it was issued under, and a refresh token whose version is no
-- longer current is refused - so these finally end a session instead of only
-- clearing the cookies on one phone. Starts at 0 for everybody; existing
-- tokens carry no version at all and are refused anyway, so everyone signs in
-- once after this ships.
ALTER TABLE "User" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
