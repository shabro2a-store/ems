import type { PrismaClient } from '@prisma/client';

/** The shape verifyWithinGeofence needs, and nothing more. */
export interface GeoBranch {
  id: string;
  lat: number;
  lng: number;
  gps_radius_m: number;
  gps_accuracy_max_m: number;
  is_active: boolean;
}

export const GEO_BRANCH_SELECT = {
  id: true,
  lat: true,
  lng: true,
  gps_radius_m: true,
  gps_accuracy_max_m: true,
  is_active: true,
} as const;

/**
 * The branches whose geofence this person is allowed to clock inside.
 *
 * One branch normally; every active branch when the owner has granted roaming,
 * so somebody can start at Hamra, cover at Achrafieh and finish there. Note
 * what does NOT change: they must still be standing inside a real branch's
 * radius with acceptable GPS. Roaming widens which branch counts, it never
 * removes the check - which is what keeps a BlockedPunchAttempt worth paying
 * on, since those rows mean "was at a branch and the system refused them".
 *
 * Read fresh on every punch, never cached: revoking the privilege has to bite
 * on the next tap, not at the next login.
 *
 * A clock-OUT additionally always accepts the branch the open check-in was made
 * at, whatever the flag says now. Without it, revoking roaming from somebody
 * mid-cover strands them: they are standing at Achrafieh inside a shift they
 * opened there, and every clock-out is refused OUT_OF_GEOFENCE until they drive
 * to Hamra or the 30h sweep closes it for them. Being able to close a shift
 * where you opened it is not a privilege the owner is granting - it is the
 * shift's own record - and it widens nothing, because the check-in it points to
 * already had to pass the geofence.
 */
export async function punchableBranches(
  db: PrismaClient,
  user: { id: string; can_roam_branches: boolean; branch: GeoBranch },
  kind: 'IN' | 'OUT',
): Promise<GeoBranch[]> {
  const allowed = user.can_roam_branches
    ? await db.branch.findMany({ where: { is_active: true }, select: GEO_BRANCH_SELECT })
    : [user.branch];

  if (kind === 'IN') return allowed;

  const openAt = await openCheckInBranchId(db, user.id);
  if (!openAt || allowed.some((b) => b.id === openAt)) return allowed;
  const arrival = await db.branch.findUnique({
    where: { id: openAt },
    select: GEO_BRANCH_SELECT,
  });
  // `is_active` is forced: verifyWithinGeofence drops inactive branches, and a
  // branch closed mid-shift must not take the clock-out down with it.
  return arrival ? [...allowed, { ...arrival, is_active: true }] : allowed;
}

/**
 * The branch of the check-in this person is currently inside, if any.
 *
 * This is where a roaming employee actually is - their own `branch_id` says
 * where they are posted, which is a different question the moment somebody is
 * covering elsewhere. Used to decide which caller board a visiting driver shows
 * on, so they appear at the branch they clocked in at and nowhere else.
 */
export async function openCheckInBranchId(
  db: PrismaClient,
  userId: string,
): Promise<string | null> {
  const lastIn = await db.punch.findFirst({
    where: { user_id: userId, kind: 'IN' },
    orderBy: { at: 'desc' },
    select: { at: true, branch_id: true },
  });
  if (!lastIn) return null;
  const laterOut = await db.punch.findFirst({
    where: { user_id: userId, kind: 'OUT', at: { gt: lastIn.at } },
    select: { id: true },
  });
  return laterOut ? null : lastIn.branch_id;
}
